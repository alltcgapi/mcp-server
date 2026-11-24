#!/usr/bin/env node
/**
 * Entry HTTP: mette `createApp` dietro `node:http`.
 *
 * L'adattatore fra `node:http` e Request/Response e' scritto qui, in trenta
 * righe, invece di aggiungere `@modelcontextprotocol/node`: chi installa il
 * pacchetto per usarlo su stdio non deve scaricare una dipendenza che serve
 * solo al nostro container.
 *
 * Non e' un secondo `bin` del pacchetto: con due, `npx -y @alltcgapi/mcp`
 * non saprebbe quale lanciare. Il container lo avvia con `node dist/http-main.js`.
 *
 * Ambiente:
 *   PORT                          default 8080
 *   ALLTCG_MCP_PUBLIC_URL         default https://mcp.alltcgapi.com/mcp
 *   ALLTCG_OAUTH_ISSUER           default https://alltcgapi.com (il sito: e' li' la pagina di
 *                                 consenso, ed e' l'`issuer` che l'API pubblica nei metadati)
 *   ALLTCG_BASE_URL               default https://api.alltcgapi.com
 *   ALLTCG_MCP_INTROSPECTION_URL  default <ALLTCG_BASE_URL>/v1/oauth/introspect
 *   ALLTCG_MCP_PROXY_SECRET       obbligatorio: lo stesso valore di MCP_PROXY_SECRET dell'API
 *                                 (si legge anche con quel nome)
 *   ALLTCG_MCP_ALLOWED_HOSTS      nomi host in piu', separati da virgola
 *   ALLTCG_MCP_ACCEPT_API_KEYS=1  solo in locale: una chiave API come Bearer
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { DEFAULT_BASE_URL } from './api.js';
import { apiKeyVerifier, createApp, introspectionVerifier } from './http.js';

// Nessuno strumento riceve un file: il corpo piu' grande e' una chiamata con
// una manciata di parametri. Un MiB e' gia' cento volte tanto.
const MAX_BODY = 1024 * 1024;

const log = (message: string): void => {
  process.stderr.write(`[alltcgapi-mcp-http] ${message}\n`);
};

const env = (name: string, fallback: string): string => {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
};

const publicUrl = new URL(env('ALLTCG_MCP_PUBLIC_URL', 'https://mcp.alltcgapi.com/mcp'));
const apiBaseUrl = env('ALLTCG_BASE_URL', DEFAULT_BASE_URL).replace(/\/+$/, '');
const acceptApiKeys = process.env['ALLTCG_MCP_ACCEPT_API_KEYS'] === '1';
// `MCP_PROXY_SECRET` e' il nome che legge l'API: accettarlo anche qui permette
// ai due container di caricare lo stesso file, e un valore solo non diverge.
const proxySecret = env('ALLTCG_MCP_PROXY_SECRET', env('MCP_PROXY_SECRET', ''));
// Senza segreto l'API rifiuta ogni token e ogni introspezione: meglio non
// partire che rispondere 401 a tutti senza dire perche'.
if (!acceptApiKeys && proxySecret === '') {
  log('ALLTCG_MCP_PROXY_SECRET is required (the same value as MCP_PROXY_SECRET on the API).');
  process.exit(1);
}

const app = createApp({
  publicUrl,
  // Deve coincidere con l'`issuer` dei metadati dell'API (OAUTH_ISSUER, per
  // difetto SITE_BASE_URL): un client legge i metadati da
  // `<issuer>/.well-known/oauth-authorization-server` e per RFC 8414 rifiuta
  // un documento che dichiara un emittente diverso da quello che ha chiesto.
  issuer: new URL(env('ALLTCG_OAUTH_ISSUER', 'https://alltcgapi.com')),
  apiBaseUrl,
  proxySecret,
  verifier: acceptApiKeys
    ? apiKeyVerifier(publicUrl.href)
    : introspectionVerifier({
        url: env('ALLTCG_MCP_INTROSPECTION_URL', `${apiBaseUrl}/v1/oauth/introspect`),
        resource: publicUrl.href,
        proxySecret,
      }),
  allowedHosts: env('ALLTCG_MCP_ALLOWED_HOSTS', '').split(',').map((host) => host.trim()).filter((host) => host !== ''),
  onerror: (error) => log(error.message),
});

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.byteLength;
    if (size > MAX_BODY) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }

  let body: Buffer | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    const read = await readBody(req);
    if (read === null) {
      res.writeHead(413, { 'content-type': 'application/json' }).end('{"error":"payload_too_large"}');
      return;
    }
    body = read;
  }

  // L'origine e' quella pubblica, non l'header Host: dietro il proxy l'Host
  // puo' essere il nome del container, e la risorsa dichiarata deve restare una.
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  const request = new Request(new URL(req.url ?? '/', publicUrl.origin), {
    method,
    headers,
    signal: abort.signal,
    ...(body === undefined ? {} : { body }),
  });

  const response = await app.fetch(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body === null) {
    res.end();
    return;
  }
  // Una risposta puo' essere uno stream SSE che resta aperto: si inoltra a
  // pezzi, e la chiusura del client arriva all'handler dal segnale sopra.
  Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>).pipe(res);
}

const server = createServer((req, res) => {
  serve(req, res).catch((error: unknown) => {
    log(error instanceof Error ? error.message : String(error));
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":"server_error"}');
  });
});

const port = Number(env('PORT', '8080'));
server.listen(port, () => {
  log(`listening on :${port} for ${publicUrl.href}${acceptApiKeys ? ' — API KEYS ACCEPTED AS BEARER, local testing only' : ''}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close();
    void app.close().finally(() => process.exit(0));
  });
}
