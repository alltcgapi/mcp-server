// Strumenti comuni ai test: il registro degli strumenti e le righe finte
// nella forma che scrive goapi (internal/catalog/render.go, internal/prices).
import { McpServer } from '@modelcontextprotocol/server';
import { Api } from '../dist/api.js';
import { createServer } from '../dist/server.js';

export const KEY = `atcg_live_${'a'.repeat(32)}`;
export const NOW = Date.parse('2026-11-19T12:00:00Z');

/** Il server con il suo registro: nome → { config, handler }. */
export function registry(t, { profile = 'local', key = KEY, now = () => NOW } = {}) {
  const register = t.mock.method(McpServer.prototype, 'registerTool');
  const server = createServer({ api: new Api('http://api.test', key), profile, now });
  const tools = new Map(register.mock.calls.map(({ arguments: [name, config, handler] }) => [name, { config, handler }]));
  return { server, tools };
}

/** Un fetch finto che risponde per percorso e ricorda cosa ha visto. */
export function fakeApi(t, routes) {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const u = new URL(String(url));
    seen.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), headers: init?.headers ?? {} });
    const answer = routes(u);
    if (answer instanceof Response) return answer;
    if (answer === undefined) throw new Error(`unexpected request ${u.pathname}${u.search}`);
    return Response.json(answer);
  });
  return seen;
}

export const errorBody = (code, message, details) => ({ error: { code, message, ...(details ? { details } : {}), request_id: 'r1' } });

export const card = (id, name, extra = {}) => ({
  id,
  game: 'onepiece',
  set: { id: '95435c34-0000-4000-8000-000000000001', code: 'OP11', name: 'A Fist of Divine Speed' },
  number: 'OP11-095',
  name,
  rarity: 'SUPER RARE',
  supertype: null,
  attributes: { types: ['Black'] },
  image_url: 'https://media.test/OP11-095.webp',
  languages: ['en'],
  external_ids: { cardmarket: 827230, tcgplayer: 612345 },
  version: 1,
  updated_at: '2026-11-18T22:21:15.182Z',
  ...extra,
});

export const set = (id, code, name, release_date, extra = {}) => ({
  id, game: 'onepiece', code, slug: code.toLowerCase(), name, region: 'WEST', release_date,
  total_cards: 120, printed_cards: 119, image_url: null, languages: ['en'], version: 1,
  updated_at: '2026-11-18T00:00:00Z', ...extra,
});

export const sealed = (id, name, languages, extra = {}) => ({
  id, game: 'onepiece', set: { id: '95435c34-0000-4000-8000-000000000001', code: 'OP11' }, sku: id, kind: 'BOOSTER_BOX',
  name, image_url: null, release_date: '2025-06-01', pack_count: 24, languages,
  external_ids: { cardmarket: 1, tcgplayer: 2 }, version: 1, updated_at: '2026-11-18T00:00:00Z', ...extra,
});

export const quote = (source, variant, amount, currency, as_of, extra = {}) => ({
  source, variant, language: 'en', condition: null, printing: null, region: null,
  price: { amount, currency }, as_of, ...extra,
});

export const page = (data, next = null) => ({
  data, meta: { limit: data.length, count: data.length, has_more: next !== null }, links: { next },
});

export const CARD_ID = '01d3a5f3-18df-4520-ac0b-4449c077f179';

/**
 * Nomi che il pacchetto pubblicato non deve contenere: una fonte interna dei
 * dati e un prodotto vicino dello stesso titolare. Scritti a pezzi perche'
 * nemmeno questo file li contenga per intero.
 */
export const FOREIGN = new RegExp(['tcg' + 'csv', 'pokemon' + 'tcgapi', 'pt' + 'cg_'].join('|'), 'i');
