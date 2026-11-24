// Il trasporto HTTP e il profilo `store`: cio' che le directory di ChatGPT e di
// Claude controllano prima di elencare il server, e il contratto OAuth con
// l'API (introspezione RFC 7662, segreto del proxy, audience).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Api, ApiError } from '../dist/api.js';
import { apiKeyVerifier, createApp, introspectionVerifier } from '../dist/http.js';
import { errorResult } from '../dist/server.js';
import { KEY, page, registry } from './helpers.mjs';

const PUBLIC = 'https://mcp.example.test/mcp';

function app(verifier = apiKeyVerifier(PUBLIC), extra = {}) {
  return createApp({
    publicUrl: new URL(PUBLIC),
    issuer: new URL('https://api.example.test'),
    apiBaseUrl: 'http://api.internal',
    verifier,
    ...extra,
  });
}

const rpc = (body, token) =>
  new Request(PUBLIC, {
    method: 'POST',
    headers: {
      // Un client vero manda sempre Host; una Request costruita a mano no.
      host: 'mcp.example.test',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
  });

/** La risposta e' JSON oppure un solo evento SSE: in entrambi i casi serve il messaggio. */
async function message(response) {
  const text = await response.text();
  const data = text.startsWith('{') ? text : text.split('\n').find((line) => line.startsWith('data: ')).slice(6);
  return JSON.parse(data);
}

test('senza token: 401 con l indirizzo dei metadati della risorsa', async () => {
  const response = await app().fetch(rpc({ method: 'tools/list' }));
  assert.equal(response.status, 401);
  assert.match(
    response.headers.get('www-authenticate'),
    /resource_metadata="https:\/\/mcp\.example\.test\/\.well-known\/oauth-protected-resource\/mcp"/,
  );
});

test('i metadati della risorsa nominano l emittente e gli scope, ai due indirizzi', async () => {
  for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
    const response = await app().fetch(new Request(`https://mcp.example.test${path}`, { headers: { host: 'mcp.example.test' } }));
    assert.equal(response.status, 200, path);
    const body = await response.json();
    assert.equal(body.resource, PUBLIC);
    assert.deepEqual(body.authorization_servers, ['https://api.example.test']);
    assert.deepEqual(body.scopes_supported, ['catalog:read', 'prices:read']);
  }
});

test('un Host che non e il nostro viene rifiutato; healthz risponde comunque', async () => {
  const bad = await app().fetch(new Request(PUBLIC, { method: 'POST', headers: { host: 'evil.test' }, body: '{}' }));
  assert.equal(bad.status, 403);
  const health = await app().fetch(new Request('http://anything/healthz'));
  assert.equal(health.status, 200);
});

test('ogni richiesta chiama l API con il token di chi la fa', async (t) => {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    seen.push({ url: String(url), key: init.headers['x-api-key'] });
    return Response.json(page([]));
  });
  const one = app();
  const call = { method: 'tools/call', params: { name: 'atcg_search_cards', arguments: { name: 'pika', limit: 1 } } };
  const other = `atcg_live_${'b'.repeat(32)}`;
  for (const token of [KEY, other]) {
    const body = await message(await one.fetch(rpc(call, token)));
    assert.equal(body.result.isError, undefined);
  }
  assert.deepEqual(seen.map((s) => s.key), [KEY, other]);
  assert.ok(seen.every((s) => s.url.startsWith('http://api.internal/v1/cards')));
});

test('tools/list su HTTP: sette strumenti, mondo chiuso nel profilo store', async () => {
  const body = await message(await app().fetch(rpc({ method: 'tools/list' }, KEY)));
  assert.equal(body.result.tools.length, 7);
  for (const tool of body.result.tools) {
    assert.equal(typeof tool.title, 'string', tool.name);
    assert.equal(tool.annotations.readOnlyHint, true, tool.name);
    assert.equal(tool.annotations.destructiveHint, false, tool.name);
    assert.equal(tool.annotations.openWorldHint, false, tool.name);
  }
});

test('profilo store: nessuna descrizione nomina crediti, piani, prove o prezzi del servizio', async (t) => {
  const { server, tools } = registry(t, { profile: 'store' });
  try {
    assert.equal(tools.size, 7);
    // «price» da solo e' il dato che il catalogo serve; qui si cerca il
    // linguaggio di vendita.
    const forbidden = /credit|growth|developer|professional|enterprise|free trial|\btrial\b|pricing|subscri|upgrade|checkout|next_step|discount|billing|€/i;
    for (const [name, { config }] of tools) {
      const text = JSON.stringify(config);
      assert.equal(forbidden.test(text), false, `${name}: ${text.match(forbidden)?.[0]}`);
    }
  } finally {
    await server.close();
  }
});

test('profilo store: un rifiuto commerciale non porta piani ne il listino', () => {
  const error = new ApiError(403, {
    code: 'TRIAL_EXPIRED',
    message: 'Your free trial credits are used up and do not renew. Choose a plan at /v1/billing/plans.',
    details: { plan: 'FREE', plans: '/v1/billing/plans' },
  });
  const text = errorResult(error, { profile: 'store', hasKey: true }).content[0].text;
  assert.match(text, /^TRIAL_EXPIRED: the connected account does not include this/);
  assert.match(text, /Their account: https:\/\/alltcgapi\.com\/account$/);
  assert.doesNotMatch(text, /plan|billing|800|free trial/i);
});

test('profilo store: gli altri errori tengono i dettagli utili e perdono il rimando al listino', () => {
  const error = new ApiError(400, {
    code: 'INVALID_PARAMETER',
    message: 'Unknown game "x". Choose a plan at /v1/billing/plans',
    details: { param: 'game', allowed: ['onepiece'], plans: '/v1/billing/plans' },
  }, 3);
  const text = errorResult(error, { profile: 'store', hasKey: true }).content[0].text;
  assert.equal(text, 'INVALID_PARAMETER: Unknown game "x". Retry after 3 s.\n{"param":"game","allowed":["onepiece"]}');
});

test('introspezione: token inattivo o emesso per un altra risorsa non passa', async (t) => {
  const answers = [{ active: false }, { active: true, aud: 'https://other.test/mcp', exp: 4102444800 }];
  t.mock.method(globalThis, 'fetch', async () => Response.json(answers.shift()));
  const verifier = introspectionVerifier({ url: 'http://api.internal/v1/oauth/introspect', resource: PUBLIC });
  await assert.rejects(verifier.verifyAccessToken('t1'), /not active/);
  await assert.rejects(verifier.verifyAccessToken('t2'), /not issued for this server/);
});

test('introspezione: una risposta buona resta in cache, un guasto dell API non e un 401', async (t) => {
  let calls = 0;
  let clock = 1_000_000;
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls += 1;
    assert.equal(init.method, 'POST');
    assert.equal(String(init.body), 'token=good');
    return Response.json({ active: true, aud: PUBLIC, client_id: 'c', scope: 'catalog:read prices:read', exp: 4102444800 });
  });
  const verifier = introspectionVerifier({ url: 'http://api.internal/i', resource: PUBLIC, now: () => clock });
  const info = await verifier.verifyAccessToken('good');
  assert.deepEqual(info.scopes, ['catalog:read', 'prices:read']);
  await verifier.verifyAccessToken('good');
  assert.equal(calls, 1);
  clock += 61_000;
  await verifier.verifyAccessToken('good');
  assert.equal(calls, 2);

  fetchMock.mock.mockImplementation(async () => new Response('down', { status: 503 }));
  const error = await verifier.verifyAccessToken('other').catch((e) => e);
  assert.equal(error.constructor.name, 'Error');
  assert.match(error.message, /503/);
});

test('un token OAuth vero passa il cancello HTTP e chiama l API con il segreto del proxy', async (t) => {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    seen.push({ url: String(url), secret: init.headers['x-mcp-proxy-secret'], key: init.headers['x-api-key'] });
    if (String(url).endsWith('/v1/oauth/introspect')) {
      return Response.json({ active: true, client_id: 'c', scope: 'catalog:read prices:read', exp: Math.floor(Date.now() / 1000) + 600, aud: PUBLIC });
    }
    return Response.json(page([]));
  });
  const verifier = introspectionVerifier({ url: 'http://api.internal/v1/oauth/introspect', resource: PUBLIC, proxySecret: 's3' });
  const oauthApp = app(verifier, { proxySecret: 's3' });
  const call = { method: 'tools/call', params: { name: 'atcg_search_cards', arguments: { name: 'pika' } } };
  const body = await message(await oauthApp.fetch(rpc(call, 'atcgoat_opaque')));
  assert.equal(body.result.isError, undefined);
  assert.deepEqual(seen.map((s) => [new URL(s.url).pathname, s.secret]), [['/v1/oauth/introspect', 's3'], ['/v1/cards', 's3']]);
  assert.equal(seen[1].key, 'atcgoat_opaque');

  // Il server stdio non ne ha: una chiave API non deve portarsi dietro l'header.
  seen.length = 0;
  await new Api('http://api.internal', KEY).get('/v1/cards', { name: 'x' });
  assert.equal(seen[0].secret, undefined);
});

test('la modalita locale accetta solo una chiave alltcgapi come Bearer', async () => {
  const verifier = apiKeyVerifier(PUBLIC);
  // La chiave di un altro servizio: una stringa qualunque, non la forma di una chiave vera di
  // qualcuno, che i controlli sui segreti di GitHub rifiutano al push.
  await assert.rejects(verifier.verifyAccessToken('another-service-key-0123456789'), /alltcgapi API key/);
  const info = await verifier.verifyAccessToken(KEY);
  assert.equal(info.resource.href, PUBLIC);
});

test('il pacchetto ha un solo eseguibile', () => {
  // Con due `bin` nessuno dei quali si chiama come il pacchetto, `npx -y
  // @alltcgapi/mcp` non sa quale lanciare e fallisce.
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(pkg.bin), ['alltcgapi-mcp']);
});
