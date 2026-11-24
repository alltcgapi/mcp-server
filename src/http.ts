/**
 * Il server su HTTP, per le directory che non accettano un server locale.
 *
 * La differenza con l'entry stdio non e' il trasporto, e' l'identita'. Su stdio
 * il processo e' di una persona e la chiave sta nell'ambiente. Qui un processo
 * serve tutti, e ogni richiesta porta il token OAuth di un utente diverso: per
 * questo la fabbrica costruisce un server e un client API per richiesta, e il
 * token dell'utente e' la credenziale con cui si chiama l'API. L'addebito
 * resta dov'e' sempre stato, sull'account di chi chiama.
 *
 * Questo modulo e' un Resource Server e basta. Non emette token e non mostra
 * pagine di consenso: quello e' il server di autorizzazione, che vive
 * nell'API (`/.well-known/oauth-authorization-server`, `/oauth/*`). Qui si
 * verifica un token, e a chi non ne ha si dice dove andare a prenderlo
 * (RFC 9728).
 */
import { createHash } from 'node:crypto';
import {
  OAuthError,
  OAuthErrorCode,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  hostHeaderValidationResponse,
  requireBearerAuth,
  type AuthInfo,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import { Api } from './api.js';
import { createServer } from './server.js';

/** Gli scope che l'API riconosce sulle rotte che gli strumenti leggono (`goapi/internal/routes`). */
export const SCOPES = ['catalog:read', 'prices:read'] as const;

export interface AppConfig {
  /** L'URL pubblico dell'endpoint MCP: e' anche l'identificatore della risorsa (RFC 8707). */
  readonly publicUrl: URL;
  /** L'emittente del server di autorizzazione. */
  readonly issuer: URL;
  /** Dove risponde l'API: in produzione il nome del container, non l'URL pubblico. */
  readonly apiBaseUrl: string;
  /**
   * Il segreto condiviso con l'API (`MCP_PROXY_SECRET` dal suo lato). L'API
   * accetta un token OAuth solo se accompagnato da questo: e' cio' che fa
   * valere il token qui e non presentato direttamente all'API da chi lo ha
   * copiato. Assente solo in locale, con le chiavi API come Bearer.
   */
  readonly proxySecret?: string;
  readonly verifier: OAuthTokenVerifier;
  /** Nomi host accettati nell'header Host, oltre a quello di `publicUrl`. */
  readonly allowedHosts?: readonly string[];
  /** La pagina che il documento della risorsa indica come documentazione. */
  readonly documentation?: string;
  readonly onerror?: (error: Error) => void;
}

export interface App {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly close: () => Promise<void>;
}

// Nessun cookie su questo host: l'unica credenziale e' il Bearer, che un sito
// terzo non possiede. Per questo l'origine aperta non espone niente, e serve
// ai client che girano in un browser (MCP Inspector).
const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id',
  'access-control-expose-headers': 'www-authenticate, mcp-session-id',
  'access-control-max-age': '86400',
};

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function createApp(config: AppConfig): App {
  const resource = config.publicUrl.href;
  const metadataUrl = getOAuthProtectedResourceMetadataUrl(config.publicUrl);
  const metadataPath = new URL(metadataUrl).pathname;

  // Scritto a mano e non con `oauthMetadataResponse` della libreria: quella
  // vuole anche i metadati del server di autorizzazione per ripubblicarli da
  // qui, cioe' una seconda copia di endpoint che appartengono all'API. Una
  // copia sola: qui si dice soltanto chi e' l'emittente.
  const protectedResource = {
    resource,
    authorization_servers: [config.issuer.href.replace(/\/$/, '')],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'alltcgapi',
    resource_documentation: config.documentation ?? 'https://alltcgapi.com/docs',
  };

  // `expectedResource` oltre al controllo del verificatore: la libreria
  // rifiuta da sola un token con un'altra audience, e due cancelli
  // indipendenti costano una comparazione di stringhe.
  const gate = requireBearerAuth({ verifier: config.verifier, resourceMetadataUrl: metadataUrl, expectedResource: config.publicUrl });

  const handler = createMcpHandler(
    (ctx) => {
      // Senza `authInfo` qui non si arriva: il cancello sta davanti. Se un
      // giorno qualcuno lo toglie, meglio un errore che un client senza
      // credenziale che parla all'API a nome di nessuno.
      if (ctx.authInfo === undefined) throw new Error('unauthenticated request reached the server factory');
      return createServer({ api: new Api(config.apiBaseUrl, ctx.authInfo.token, proxyHeaders(config.proxySecret)), profile: 'store' });
    },
    config.onerror === undefined ? {} : { onerror: config.onerror },
  );

  const hosts = [config.publicUrl.hostname, 'localhost', '127.0.0.1', ...(config.allowedHosts ?? [])];

  return {
    close: () => handler.close(),
    fetch: async (request) => {
      const url = new URL(request.url);

      // Prima di tutto, anche dell'header Host: e' il controllo che Docker fa
      // dall'interno del container.
      if (url.pathname === '/healthz') return new Response('ok\n', { headers: { 'content-type': 'text/plain' } });

      const badHost = hostHeaderValidationResponse(request, hosts);
      if (badHost !== undefined) return badHost;

      if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }));

      // I due indirizzi: quello con il percorso della risorsa (RFC 9728) e
      // quello alla radice, che alcuni client provano per primo.
      if (url.pathname === metadataPath || url.pathname === '/.well-known/oauth-protected-resource') {
        if (request.method !== 'GET') return withCors(json({ error: 'method_not_allowed' }, 405));
        const response = json(protectedResource);
        response.headers.set('cache-control', 'public, max-age=3600');
        return withCors(response);
      }

      if (url.pathname !== config.publicUrl.pathname) return withCors(json({ error: 'not_found' }, 404));

      const auth = await gate(request);
      if (auth instanceof Response) return withCors(auth);
      return withCors(await handler.fetch(request, { authInfo: auth }));
    },
  };
}

const invalidToken = (message: string) => new OAuthError(OAuthErrorCode.InvalidToken, message);

const normalise = (value: string): string => value.replace(/\/$/, '');

/** L'header con cui questo server si fa riconoscere dall'API. */
export const PROXY_SECRET_HEADER = 'x-mcp-proxy-secret';

function proxyHeaders(secret: string | undefined): Record<string, string> {
  return secret === undefined || secret === '' ? {} : { [PROXY_SECRET_HEADER]: secret };
}

export interface IntrospectionOptions {
  /** L'endpoint RFC 7662 dell'API, raggiungibile solo dalla rete interna. */
  readonly url: string;
  /** La risorsa per cui il token deve essere stato emesso. */
  readonly resource: string;
  /** Senza questo l'API risponde 401 all'introspezione. */
  readonly proxySecret?: string;
  /** Per quanto una risposta positiva resta buona, al massimo fino alla scadenza del token. */
  readonly cacheSeconds?: number;
  readonly now?: () => number;
}

/**
 * Verifica un token chiedendolo all'API (RFC 7662).
 *
 * I token sono opachi, non JWT: la revoca deve valere subito, e un token che
 * si verifica da solo vale fino alla scadenza qualunque cosa succeda
 * all'account. Il prezzo e' una chiamata in piu', che la cache riduce a una
 * al minuto per token. Si memorizzano solo le risposte positive, e con chiave
 * l'hash: il token in chiaro non resta in un Map piu' a lungo della richiesta.
 */
export function introspectionVerifier(options: IntrospectionOptions): OAuthTokenVerifier {
  const ttl = (options.cacheSeconds ?? 60) * 1000;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { info: AuthInfo; until: number }>();
  const wanted = normalise(options.resource);

  return {
    async verifyAccessToken(token) {
      const key = createHash('sha256').update(token).digest('hex');
      const hit = cache.get(key);
      if (hit !== undefined && hit.until > now()) return hit.info;
      cache.delete(key);

      const response = await fetch(options.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded', accept: 'application/json',
          ...proxyHeaders(options.proxySecret),
        },
        body: new URLSearchParams({ token }),
        signal: AbortSignal.timeout(5000),
      });
      // Un guasto dell'API non e' un token sbagliato: rispondere 401 farebbe
      // buttare al client una concessione buona. L'eccezione generica esce
      // come errore del server, e il client riprova.
      if (!response.ok) throw new Error(`token introspection answered ${response.status}`);

      const body = (await response.json()) as {
        active?: boolean; client_id?: string; scope?: string; exp?: number; aud?: string | string[];
      };
      if (body.active !== true) throw invalidToken('The access token is not active.');

      const audiences = (Array.isArray(body.aud) ? body.aud : [body.aud ?? '']).map(normalise);
      // Un token emesso per un'altra risorsa non vale qui, anche se e' attivo.
      if (!audiences.includes(wanted)) throw invalidToken('The access token was not issued for this server.');

      const info: AuthInfo = {
        token,
        clientId: body.client_id ?? '',
        scopes: (body.scope ?? '').split(' ').filter((scope) => scope !== ''),
        resource: new URL(options.resource),
        ...(body.exp === undefined ? {} : { expiresAt: body.exp }),
      };
      // Un Map senza tetto e' una perdita di memoria che si presenta dopo
      // settimane: svuotarlo tutto costa una introspezione in piu' a testa.
      if (cache.size >= 5000) cache.clear();
      cache.set(key, { info, until: Math.min(now() + ttl, body.exp === undefined ? Infinity : body.exp * 1000) });
      return info;
    },
  };
}

/**
 * Accetta una chiave API come Bearer. Solo per provare in locale.
 *
 * Esiste perche' senza il server di autorizzazione non ci sarebbe modo di
 * provare gli strumenti su HTTP. Non verifica niente: la chiave la giudica
 * l'API alla prima chiamata. Non va acceso sul server elencato nelle
 * directory, che vietano di chiedere chiavi agli utenti.
 */
export function apiKeyVerifier(resource: string): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token) {
      if (!/^atcg_(live|test)_[A-Za-z0-9]{20,}$/.test(token)) throw invalidToken('Expected an alltcgapi API key.');
      // La libreria rifiuta un token senza scadenza. Una chiave non ne ha:
      // se ne dichiara una breve, che si rinnova a ogni richiesta.
      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      return { token, clientId: 'api-key', scopes: [...SCOPES], resource: new URL(resource), expiresAt };
    },
  };
}
