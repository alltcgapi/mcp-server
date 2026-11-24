/**
 * Client HTTP minimo verso api.alltcgapi.com.
 *
 * PERCHE' NON DIPENDE DALL'SDK: questo server usa otto rotte in sola lettura e
 * non pagina mai in profondita' (ogni risposta e' tagliata a 50 righe prima di
 * tornare a un modello), quindi di un SDK userebbe il trasporto e nient'altro.
 * In cambio porterebbe un secondo pacchetto da tenere allineato in versione a
 * ogni pubblicazione. La copia e' un centinaio di righe e si legge tutta.
 *
 * La forma degli errori e' quella di `goapi/internal/httpx/respond.go`:
 * `{ "error": { "code", "message", "details"?, "request_id" } }`.
 */

export const DEFAULT_BASE_URL = 'https://api.alltcgapi.com';
const TIMEOUT_MS = 20_000;
const USER_AGENT = '@alltcgapi/mcp';

export interface ApiErrorShape {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly request_id?: string;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  readonly requestId: string | undefined;
  /**
   * I secondi di `Retry-After`, quando l'API li manda (solo sui 429 che si
   * riaprono aspettando). Su `TRIAL_EXPIRED` non c'e' di proposito: i crediti
   * della prova non tornano, e un modello che legge un'attesa riprova.
   */
  readonly retryAfter: number | undefined;

  constructor(status: number, body: ApiErrorShape, retryAfter?: number) {
    super(`${body.code}: ${body.message}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.details = body.details;
    this.requestId = body.request_id;
    this.retryAfter = retryAfter;
  }
}

/**
 * L'API non si e' raggiunta: DNS, connessione rifiutata, TLS. Separato da
 * ApiError perche' il rimedio e' un altro — la configurazione o la rete, non
 * la richiesta — e perche' `fetch` lo dice con un «fetch failed» che a un
 * modello non dice niente.
 */
export class NetworkError extends Error {
  readonly baseUrl: string;
  override readonly cause: unknown;

  constructor(baseUrl: string, cause: unknown) {
    const code = (cause as { cause?: { code?: string } } | undefined)?.cause?.code;
    super(`Could not reach the API${code === undefined ? '' : ` (${code})`}.`);
    this.name = 'NetworkError';
    this.baseUrl = baseUrl;
    this.cause = cause;
  }
}

/** Una lista dell'API. `links.next` e' `null` sull'ultima pagina, non assente. */
export interface Envelope<T> {
  readonly data: readonly T[];
  readonly meta?: { readonly limit: number; readonly count: number; readonly has_more: boolean };
  readonly links?: { readonly next?: string | null };
}

/** Un oggetto singolo dell'API: `/v1/cards/{id}`, `/v1/status`. */
export interface Single<T> {
  readonly data: T;
}

function retryAfterOf(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (raw === null || raw.trim() === '') return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

export class Api {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly extraHeaders: Readonly<Record<string, string>>;

  /**
   * `extraHeaders` viaggia con ogni richiesta. Lo usa solo il server HTTP, per
   * provare all'API che un token OAuth lo sta presentando lui (vedi http.ts).
   */
  constructor(
    baseUrl = process.env['ALLTCG_BASE_URL'] ?? DEFAULT_BASE_URL,
    apiKey = process.env['ALLTCG_API_KEY'],
    extraHeaders: Readonly<Record<string, string>> = {},
  ) {
    this.baseUrl = (baseUrl === '' ? DEFAULT_BASE_URL : baseUrl).replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.extraHeaders = extraHeaders;
  }

  /** Vuota conta come assente: e' il segnaposto non espanso di una configurazione sbagliata. */
  get hasKey(): boolean {
    return this.apiKey !== undefined && this.apiKey !== '';
  }

  async get<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      // L'API rifiuta un parametro vuoto come uno sconosciuto: si omette.
      if (value === undefined || value === null || value === '') continue;
      search.set(key, String(value));
    }

    const query = search.toString();
    const url = `${this.baseUrl}${path}${query === '' ? '' : `?${query}`}`;

    const headers: Record<string, string> = {
      ...this.extraHeaders,
      accept: 'application/json',
      'user-agent': USER_AGENT,
    };
    // Lo stesso header per una chiave e per un token OAuth: l'API li distingue
    // dal prefisso. Assente se vuota, cosi' la risposta e' MISSING_API_KEY e
    // non INVALID_API_KEY, che manderebbe a cercare una chiave sbagliata.
    if (this.hasKey && this.apiKey !== undefined) headers['x-api-key'] = this.apiKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      let response: Response;
      try {
        response = await fetch(url, { headers, signal: controller.signal });
      } catch (error) {
        // Il timeout resta un AbortError: ha un messaggio suo in errorResult.
        if (error instanceof Error && error.name === 'AbortError') throw error;
        throw new NetworkError(this.baseUrl, error);
      }

      if (!response.ok) {
        let body: ApiErrorShape = { code: `HTTP_${response.status}`, message: response.statusText };
        try {
          const parsed = (await response.json()) as { error?: ApiErrorShape };
          if (parsed.error?.code !== undefined) body = parsed.error;
        } catch {
          /* la risposta non era il nostro envelope: si tiene quella costruita sopra */
        }
        throw new ApiError(response.status, body, retryAfterOf(response));
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
