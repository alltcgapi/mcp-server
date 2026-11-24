// Gli errori dell'API come li legge un modello: cosa deve poter fare dopo.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Api, ApiError } from '../dist/api.js';
import { errorResult } from '../dist/server.js';
import { errorBody, fakeApi, registry } from './helpers.mjs';

test('chiave assente: l aiuto dice che e una variabile del client e dove si chiede', () => {
  const error = new ApiError(401, { code: 'MISSING_API_KEY', message: 'This endpoint requires an API key. Send it as "X-Api-Key: <key>".' });
  const text = errorResult(error, { profile: 'local', hasKey: false }).content[0].text;
  assert.match(text, /^ALLTCG_API_KEY is not set/);
  assert.match(text, /environment variable in the MCP client configuration/);
  assert.match(text, /https:\/\/alltcgapi\.com\/free-api-key/);
  // L'iscrizione e' aperta: niente «scrivici» e niente «in prova privata».
  assert.doesNotMatch(text, /private testing|by hand|info@/);
  assert.doesNotMatch(text, /X-Api-Key/);
});

test('chiave presente ma rifiutata: passa il messaggio dell API, non l aiuto', () => {
  const error = new ApiError(401, { code: 'INVALID_API_KEY', message: 'The API key is not valid.' });
  assert.equal(errorResult(error, { profile: 'local', hasKey: true }).content[0].text, 'INVALID_API_KEY: The API key is not valid.');
});

test('429: Retry-After arriva al modello, letto dall header', async (t) => {
  const { server, tools } = registry(t);
  fakeApi(t, () => Response.json(errorBody('RATE_LIMITED', 'Rate limit exceeded: your plan allows 5 requests per second.', { window: 'second', limit: 5 }), {
    status: 429, headers: { 'retry-after': '1' },
  }));
  try {
    const result = await tools.get('atcg_search_cards').handler({ name: 'pika' });
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, 'RATE_LIMITED: Rate limit exceeded: your plan allows 5 requests per second. Retry after 1 s.\n{"window":"second","limit":5}');
  } finally {
    await server.close();
  }
});

test('un gioco sconosciuto torna con l elenco dei giochi validi', async (t) => {
  const { server, tools } = registry(t);
  fakeApi(t, () => Response.json(errorBody('INVALID_PARAMETER', 'Unknown game "x".', { param: 'game', allowed: ['onepiece', 'pokemon'] }), { status: 400 }));
  try {
    const result = await tools.get('atcg_list_sets').handler({});
    assert.match(result.content[0].text, /"allowed":\["onepiece","pokemon"\]/);
  } finally {
    await server.close();
  }
});

test('una risposta che non e il nostro envelope diventa HTTP_<stato>', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }));
  const error = await new Api('http://api.test', 'k').get('/v1/games').catch((e) => e);
  assert.equal(error.code, 'HTTP_502');
  assert.equal(error.status, 502);
});

test('un timeout si legge come tale, non come un errore qualunque', () => {
  const abort = new Error('This operation was aborted');
  abort.name = 'AbortError';
  assert.match(errorResult(abort).content[0].text, /did not answer within 20 seconds/);
});

test('TRIAL_EXPIRED nel profilo locale passa invariato, senza Retry-After', () => {
  const error = new ApiError(403, {
    code: 'TRIAL_EXPIRED',
    message: 'Your free trial credits are used up and do not renew. Choose a plan at /v1/billing/plans.',
    details: { plan: 'FREE', plans: '/v1/billing/plans' },
  });
  const text = errorResult(error, { profile: 'local', hasKey: true }).content[0].text;
  assert.match(text, /^TRIAL_EXPIRED: Your free trial credits are used up and do not renew/);
  assert.doesNotMatch(text, /Retry after/);
});

test('rete irraggiungibile: niente «fetch failed», ma cosa controllare; l host interno solo in locale', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
  });
  const error = await new Api('http://goapi:8080', 'k').get('/v1/games').catch((e) => e);
  const local = errorResult(error, { profile: 'local', hasKey: true }).content[0].text;
  assert.equal(local, 'Could not reach the API (ECONNREFUSED). Base URL: http://goapi:8080. Check ALLTCG_BASE_URL in the MCP client configuration, or the network.');
  const store = errorResult(error, { profile: 'store', hasKey: true }).content[0].text;
  assert.doesNotMatch(store, /goapi|ALLTCG_BASE_URL/);
});
