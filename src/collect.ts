import { ApiError, type Envelope } from './api.js';

/**
 * Raccolta paginata con filtro locale.
 *
 * Serve perche' alcune domande che un agente fa di continuo l'API non le
 * filtra: il nome di un set («il set che si chiama Wings of the Captain»), una
 * finestra di uscita («i set del 2025»), il nome o la lingua di un sigillato.
 * Filtrare la PRIMA pagina e basta risponderebbe «nessun risultato» a «set del
 * 2024», perche' la prima pagina, ordinata dal piu' recente, e' fatta di set
 * del 2026.
 *
 * Due garanzie, entrambe necessarie:
 *
 * - `stop` permette di terminare presto quando la lista e' ordinata e siamo
 *   usciti dalla finestra: senza, scorrere fino agli anni Novanta per prendere
 *   il 2024 costerebbe decine di richieste.
 * - `exhausted` dice se la scansione ha davvero visto tutto. Se e' falso il
 *   chiamante DEVE dirlo nella risposta: un elenco parziale presentato come
 *   completo e' il modo in cui un agente conclude che una carta non esiste.
 */
export interface Collected<T> {
  readonly rows: readonly T[];
  /** true se la scansione e' arrivata in fondo o ha incontrato `stop`. */
  readonly exhausted: boolean;
  readonly scannedPages: number;
  readonly nextCursor: string | undefined;
  /**
   * true quando il limite si e' riempito a meta' di una pagina.
   *
   * E' il caso in cui NON si puo' consegnare un cursore: `links.next` punta
   * alla pagina dopo, quindi riprendere da li' salterebbe le righe rimaste in
   * quella corrente. Succede solo quando la pagina chiesta e' piu' grande del
   * limite, cioe' quando si filtra in locale.
   */
  readonly truncatedMidPage: boolean;
}

export type Verdict = 'keep' | 'skip' | 'stop';

/**
 * Attesa massima che una scansione accetta per un 429 prima di arrendersi.
 *
 * Una scansione legge fino a otto pagine di fila, e il limite al secondo dei
 * piani piccoli (5 richieste) si tocca davvero: provato contro l'API locale il
 * 19/11/2026. Senza riprovare, un 429 alla quinta pagina butterebbe le quattro
 * gia' pagate. Oltre i due secondi il limite non e' quello al secondo, e si
 * restituisce l'errore com'e'.
 */
const RETRY_CEILING_S = 2;

async function fetchWithRetry<T>(
  fetchPage: (cursor: string | undefined) => Promise<Envelope<T>>,
  cursor: string | undefined,
): Promise<Envelope<T>> {
  try {
    return await fetchPage(cursor);
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.code === 'RATE_LIMITED' &&
      error.retryAfter !== undefined &&
      error.retryAfter <= RETRY_CEILING_S
    ) {
      const wait = error.retryAfter * 1000;
      await new Promise((resolve) => setTimeout(resolve, wait));
      return fetchPage(cursor);
    }
    throw error;
  }
}

export async function collect<T>(
  fetchPage: (cursor: string | undefined) => Promise<Envelope<T>>,
  verdict: (row: T) => Verdict,
  limit: number,
  maxPages = 8,
): Promise<Collected<T>> {
  const rows: T[] = [];
  let cursor: string | undefined;
  let pages = 0;
  let stopped = false;
  let truncatedMidPage = false;

  while (pages < maxPages) {
    const body = await fetchWithRetry(fetchPage, cursor);
    pages += 1;

    let seen = 0;
    for (const row of body.data) {
      seen += 1;
      const call = verdict(row);
      if (call === 'stop') {
        stopped = true;
        break;
      }
      if (call === 'keep') rows.push(row);
      if (rows.length >= limit) break;
    }
    truncatedMidPage = !stopped && rows.length >= limit && seen < body.data.length;

    // L'API scrive `"next": null` sull'ultima pagina: null e assente sono la
    // stessa cosa, e confrontare solo con undefined faceva girare la
    // scansione su un cursore inesistente.
    const next = body.links?.next ?? undefined;
    if (stopped || rows.length >= limit || next === undefined) {
      return {
        rows,
        // Fermarsi a meta' pagina NON e' aver visto tutto, nemmeno sull'ultima
        // pagina.
        exhausted: (stopped || next === undefined) && !truncatedMidPage,
        scannedPages: pages,
        // Un cursore si consegna SOLO se la pagina e' stata letta per intero:
        // darlo dopo essersi fermati a meta' fa saltare in silenzio le righe
        // rimaste. Meglio nessun cursore e dirlo.
        nextCursor:
          rows.length >= limit && !truncatedMidPage && next !== undefined ? cursorOf(next) : undefined,
        truncatedMidPage,
      };
    }

    cursor = cursorOf(next);
    if (cursor === undefined) break;
  }

  return { rows, exhausted: false, scannedPages: pages, nextCursor: cursor, truncatedMidPage: false };
}

/** Il cursore e' opaco: si estrae dall'URL che l'API ha costruito, mai ricomposto. */
export function cursorOf(nextUrl: string | null | undefined): string | undefined {
  if (nextUrl === null || nextUrl === undefined || nextUrl === '') return undefined;
  try {
    return new URL(nextUrl).searchParams.get('cursor') ?? undefined;
  } catch {
    return undefined;
  }
}
