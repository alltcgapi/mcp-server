// Gli strumenti contro un'API finta nella forma di goapi. Ogni test qui
// corrisponde a un modo in cui un agente sbaglierebbe senza quella riga.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GAME_IDS } from '../dist/games.js';
import { TOOL_NAMES, boundary } from '../dist/server.js';
import { CARD_ID, FOREIGN, card, errorBody, fakeApi, page, quote, registry, sealed, set } from './helpers.mjs';

const NEXT = 'https://api.alltcgapi.com/v1/cards?cursor=eyJrIjpbXX0&limit=20';

test('sette strumenti, tutti in sola lettura, con titolo e regola di consegna', async (t) => {
  const { server, tools } = registry(t);
  try {
    assert.deepEqual([...tools.keys()], [...TOOL_NAMES]);
    const suffix = ' If a call is refused with TRIAL_EXPIRED or QUOTA_EXCEEDED, tell the user as written and do not retry; RATE_LIMITED says how many seconds to wait.';
    for (const [name, { config }] of tools) {
      assert.equal(typeof config.title, 'string', name);
      assert.equal(config.annotations.readOnlyHint, true, name);
      assert.equal(config.annotations.destructiveHint, false, name);
      assert.ok(name.length <= 64, name);
      assert.ok(config.description.endsWith(suffix), name);
      assert.doesNotMatch(config.description, FOREIGN, name);
    }
  } finally {
    await server.close();
  }
});

test('l enum dei giochi e quello di /v1/games: diciannove id', () => {
  assert.deepEqual([...GAME_IDS].sort(), [
    'battlespirits', 'cyberpunk', 'digimon', 'dragoborne', 'dragonball-fw', 'dragonball-masters', 'fab', 'fftcg',
    'fow', 'gundam', 'lorcana', 'onepiece', 'pokemon', 'riftbound', 'swdestiny', 'swu', 'vanguard', 'weissschwarz', 'yugioh',
  ]);
});

test('ricerca carte: i filtri arrivano all API, il cursore si estrae da links.next', async (t) => {
  const { server, tools } = registry(t);
  const seen = fakeApi(t, (u) => (u.pathname === '/v1/cards' ? page([card(CARD_ID, 'Monkey.D.Garp')], NEXT) : undefined));
  try {
    const result = await tools.get('atcg_search_cards').handler({ name: ' monkey.d ', game: 'onepiece', limit: 500 });
    assert.deepEqual(seen[0].query, { game: 'onepiece', name: 'monkey.d', limit: '50' });
    assert.equal(seen[0].headers['x-api-key'].startsWith('atcg_live_'), true);
    const text = result.content[0].text;
    assert.match(text, new RegExp(`${CARD_ID}\\s+onepiece\\s+Monkey\\.D\\.Garp\\s+OP11\\s+A Fist of Divine Speed\\s+OP11-095\\s+SUPER RARE`));
    assert.match(text, /More rows available\. Call again with cursor="eyJrIjpbXX0"\./);
    assert.equal(result.structuredContent.next_cursor, 'eyJrIjpbXX0');
  } finally {
    await server.close();
  }
});

test('ricerca carte: senza filtri si rifiuta prima di spendere una chiamata', async (t) => {
  const { server, tools } = registry(t);
  const seen = fakeApi(t, () => undefined);
  try {
    const result = await tools.get('atcg_search_cards').handler({ game: 'pokemon' });
    assert.equal(result.isError, true);
    assert.equal(seen.length, 0);
  } finally {
    await server.close();
  }
});

test('ricerca carte: zero righe su un nome di piu parole suggerisce il prefisso corto', async (t) => {
  const { server, tools } = registry(t);
  fakeApi(t, () => page([]));
  try {
    const result = await tools.get('atcg_search_cards').handler({ name: 'charizard dark' });
    assert.match(result.content[0].text, /No card name starts with "charizard dark"\. Retry with name="charizard"/);
    assert.doesNotMatch(result.content[0].text, /More rows/);
    assert.equal(result.structuredContent.next_cursor, null);
  } finally {
    await server.close();
  }
});

test('dettaglio carta: un id che non e un uuid non arriva all API', async (t) => {
  const { server, tools } = registry(t);
  const seen = fakeApi(t, () => undefined);
  try {
    const result = await tools.get('atcg_get_card').handler({ id: 'OP11-095' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /UUIDs.*atcg_search_cards/);
    assert.equal(seen.length, 0);
  } finally {
    await server.close();
  }
});

test('dettaglio carta con i prezzi: due chiamate in parallelo, nomi per lingua e id dei marketplace', async (t) => {
  const { server, tools } = registry(t);
  const seen = fakeApi(t, (u) => {
    if (u.pathname === `/v1/cards/${CARD_ID}`) return { data: card(CARD_ID, 'Monkey.D.Garp', { names: { en: 'Monkey.D.Garp', ja: 'モンキー・D・ガープ' } }) };
    if (u.pathname === `/v1/cards/${CARD_ID}/prices`) return { data: [quote('CARDMARKET', 'LOWEST_NEAR_MINT', 12.5, 'EUR', '2026-11-17')] };
    return undefined;
  });
  try {
    const result = await tools.get('atcg_get_card').handler({ id: CARD_ID, include_prices: true });
    assert.deepEqual(seen.map((s) => s.path).sort(), [`/v1/cards/${CARD_ID}`, `/v1/cards/${CARD_ID}/prices`]);
    const text = result.content[0].text;
    assert.match(text, /^Monkey\.D\.Garp — One Piece Card Game \(onepiece\)/);
    assert.match(text, /names en: Monkey\.D\.Garp · ja: モンキー・D・ガープ/);
    assert.match(text, /marketplace ids: cardmarket 827230, tcgplayer 612345/);
    assert.match(text, /Current quotes:\nEUR: 1 quote from CARDMARKET, as of 2026-11-17\./);
    assert.equal(result.structuredContent.quotes.length, 1);
  } finally {
    await server.close();
  }
});

test('dettaglio carta: gli attributi lunghi si tagliano nel testo e lo dicono, interi nello structured', async (t) => {
  const { server, tools } = registry(t);
  const long = { text: 'x'.repeat(3000) };
  fakeApi(t, () => ({ data: card(CARD_ID, 'Long', { attributes: long }) }));
  try {
    const result = await tools.get('atcg_get_card').handler({ id: CARD_ID });
    assert.match(result.content[0].text, /… \(cut here; the full object is in the structured result\)/);
    assert.equal(result.structuredContent.card.attributes.text.length, 3000);
  } finally {
    await server.close();
  }
});

test('set: una finestra «2025» legge pagine da 250, salta il 2026 e si ferma al 2024', async (t) => {
  const { server, tools } = registry(t);
  const seen = fakeApi(t, (u) => {
    if (u.searchParams.get('cursor') === null) {
      return page(
        [set('a0000000-0000-4000-8000-000000000001', 'OP14', 'New', '2026-03-01'), set('a0000000-0000-4000-8000-000000000002', 'OP12', 'Mid', '2025-08-01')],
        'https://api.alltcgapi.com/v1/sets?cursor=p2&limit=250',
      );
    }
    return page([set('a0000000-0000-4000-8000-000000000003', 'OP10', 'Early', '2025-01-10'), set('a0000000-0000-4000-8000-000000000004', 'OP09', 'Old', '2024-12-01')], 'https://api.alltcgapi.com/v1/sets?cursor=p3&limit=250');
  });
  try {
    const result = await tools.get('atcg_list_sets').handler({ game: 'onepiece', released_from: '2025', released_to: '2025' });
    assert.deepEqual(seen.map((s) => s.query), [{ game: 'onepiece', limit: '250' }, { game: 'onepiece', limit: '250', cursor: 'p2' }]);
    assert.deepEqual(result.structuredContent.sets.map((s) => s.code), ['OP12', 'OP10']);
    assert.equal(result.structuredContent.complete, true);
    assert.doesNotMatch(result.content[0].text, /More rows|Scan stopped/);
  } finally {
    await server.close();
  }
});

test('set: senza filtri locali una pagina sola, grande quanto il limite', async (t) => {
  const { server, tools } = registry(t);
  const seen = fakeApi(t, () => page([set('a0000000-0000-4000-8000-000000000001', 'OP14', 'New', '2026-03-01')], 'https://api.alltcgapi.com/v1/sets?cursor=c2'));
  try {
    const result = await tools.get('atcg_list_sets').handler({ game: 'onepiece', region: 'EAST', limit: 1 });
    assert.deepEqual(seen[0].query, { game: 'onepiece', region: 'EAST', limit: '1' });
    assert.match(result.content[0].text, /cursor="c2"/);
  } finally {
    await server.close();
  }
});

test('set: una data che non e una data si rifiuta', async (t) => {
  const { server, tools } = registry(t);
  try {
    const result = await tools.get('atcg_list_sets').handler({ released_from: 'last year' });
    assert.equal(result.isError, true);
  } finally {
    await server.close();
  }
  assert.equal(boundary('2025-03', 'to'), '2025-03-31');
  assert.equal(boundary('2025-03-04', 'from'), '2025-03-04');
  assert.equal(boundary(undefined, 'from'), undefined);
});

test('carte di un set: la prima riga dice set e gioco, in ordine di numero', async (t) => {
  const { server, tools } = registry(t);
  const seen = fakeApi(t, () => page([card(CARD_ID, 'Monkey.D.Garp')]));
  try {
    const result = await tools.get('atcg_list_set_cards').handler({ set: 'OP11', limit: 10 });
    assert.equal(seen[0].path, '/v1/sets/OP11/cards');
    assert.match(result.content[0].text, /^Set OP11 — A Fist of Divine Speed \(onepiece, set id 95435c34-/);
  } finally {
    await server.close();
  }
});

test('sigillati: nome e lingua si filtrano in locale su pagine da 100', async (t) => {
  const { server, tools } = registry(t);
  const seen = fakeApi(t, () => page([
    sealed('b0000000-0000-4000-8000-000000000001', 'OP-11 Booster Box', ['en']),
    sealed('b0000000-0000-4000-8000-000000000002', 'OP-11 Booster Box (Japanese)', ['ja']),
    sealed('b0000000-0000-4000-8000-000000000003', 'Starter Deck', ['ja']),
  ]));
  try {
    const result = await tools.get('atcg_search_sealed').handler({ game: 'onepiece', kind: 'booster_box', name: 'booster box', language: 'JA' });
    assert.deepEqual(seen[0].query, { game: 'onepiece', kind: 'BOOSTER_BOX', limit: '100' });
    assert.deepEqual(result.structuredContent.products.map((p) => p.name), ['OP-11 Booster Box (Japanese)']);
    assert.equal(result.structuredContent.complete, true);
  } finally {
    await server.close();
  }
});

test('prezzi: una riga per valuta, il divieto di sommarle e la quotazione vecchia segnalata', async (t) => {
  const { server, tools } = registry(t);
  const seen = fakeApi(t, () => ({
    data: [
      quote('CARDMARKET', 'LOWEST_NEAR_MINT', 12.5, 'EUR', '2026-11-17', { condition: 'NEAR_MINT', region: 'EU' }),
      quote('CARDMARKET', 'TREND', 13.1, 'EUR', '2026-11-18'),
      quote('TCGPLAYER', 'MARKET', 14.2, 'USD', '2026-11-01', { printing: 'NORMAL' }),
    ],
  }));
  try {
    const result = await tools.get('atcg_get_prices').handler({ type: 'card', id: CARD_ID, language: 'EN' });
    assert.equal(seen[0].path, `/v1/cards/${CARD_ID}/prices`);
    assert.deepEqual(seen[0].query, { language: 'en' });
    const text = result.content[0].text;
    assert.match(text, /EUR: 2 quotes from CARDMARKET, as of 2026-11-17 to 2026-11-18\./);
    assert.match(text, /USD: 1 quote from TCGPLAYER, as of 2026-11-01 — the newest is 18 days old, say so when quoting it\./);
    assert.match(text, /Different currencies: report EUR and USD separately, never as one figure\./);
    assert.match(text, /CARDMARKET\s+LOWEST_NEAR_MINT\s+12\.5\s+EUR\s+en\s+NEAR_MINT\s+—\s+EU\s+2026-11-17/);
    assert.match(text, /TCGPLAYER\s+MARKET\s+14\.2\s+USD\s+en\s+—\s+NORMAL/);
    assert.deepEqual(result.structuredContent.by_currency.map((s) => s.currency), ['EUR', 'USD']);
    // Nessun totale, da nessuna parte.
    assert.doesNotMatch(JSON.stringify(result.structuredContent), /total|sum|average/i);
  } finally {
    await server.close();
  }
});

test('prezzi: la colonna eu_only compare solo quando una riga la porta', async (t) => {
  const { server, tools } = registry(t);
  let data = [
    quote('CARDMARKET', 'LOWEST_NEAR_MINT', 12.5, 'EUR', '2026-11-18', { eu_only: false }),
    quote('CARDMARKET', 'LOWEST_NEAR_MINT', 13.9, 'EUR', '2026-11-18', { eu_only: true }),
  ];
  fakeApi(t, () => ({ data }));
  try {
    const handler = tools.get('atcg_get_prices').handler;
    const both = (await handler({ type: 'card', id: CARD_ID })).content[0].text;
    assert.match(both, /eu_only = yes: the source counted sellers in the European Union only\./);
    assert.match(both, /region\s+eu_only\s+as_of/);
    assert.match(both, /12\.5\s+EUR\s+en\s+—\s+—\s+—\s+no\s+2026-11-18/);
    assert.match(both, /13\.9\s+EUR\s+en\s+—\s+—\s+—\s+yes\s+2026-11-18/);

    data = [quote('CARDMARKET', 'TREND', 13.1, 'EUR', '2026-11-18', { eu_only: false })];
    const plain = (await handler({ type: 'card', id: CARD_ID })).content[0].text;
    assert.doesNotMatch(plain, /eu_only/);
  } finally {
    await server.close();
  }
});

test('prezzi: il filtro di valuta dice quante righe ha lasciato fuori; un elenco vuoto non e un oggetto mancante', async (t) => {
  const { server, tools } = registry(t);
  let data = [quote('CARDMARKET', 'LOWEST', 149, 'EUR', '2026-11-17'), quote('TCGPLAYER', 'MARKET', 160, 'USD', '2026-11-17')];
  const seen = fakeApi(t, () => ({ data }));
  try {
    const handler = tools.get('atcg_get_prices').handler;
    const usd = await handler({ type: 'sealed', id: CARD_ID, currency: 'USD', source: 'TCGPLAYER' });
    assert.equal(seen[0].path, `/v1/sealed/${CARD_ID}/prices`);
    assert.deepEqual(seen[0].query, { source: 'TCGPLAYER' });
    assert.match(usd.content[0].text, /1 quote in other currencies left out by currency=USD\./);
    assert.equal(usd.structuredContent.quotes.length, 1);

    data = [];
    const none = await handler({ type: 'card', id: CARD_ID });
    assert.match(none.content[0].text, /No current quote for this item.*That is not a missing item/s);
  } finally {
    await server.close();
  }
});

test('prezzi: un id non uuid rimanda allo strumento di ricerca giusto', async (t) => {
  const { server, tools } = registry(t);
  try {
    const result = await tools.get('atcg_get_prices').handler({ type: 'sealed', id: 'op11-box' });
    assert.match(result.content[0].text, /Sealed product ids are UUIDs.*atcg_search_sealed/);
  } finally {
    await server.close();
  }
});

test('copertura: conteggi, prezzi per fonte, giochi non serviti e giochi sconosciuti a questo pacchetto', async (t) => {
  const { server, tools } = registry(t);
  fakeApi(t, (u) => {
    if (u.pathname === '/v1/games') {
      return { data: [{ id: 'onepiece', name: 'One Piece Card Game', sets: 70, cards: 4000, sealed: 120 }, { id: 'newgame', name: 'New Game', sets: 1, cards: 10, sealed: 0 }] };
    }
    if (u.pathname === '/v1/prices/coverage') {
      return { data: [
        { game: 'onepiece', source: 'CARDMARKET', cards: 3500, sealed: 90, as_of: '2026-11-18' },
        { game: 'onepiece', source: 'TCGPLAYER', cards: 3900, sealed: 0, as_of: '2026-11-17' },
      ] };
    }
    if (u.pathname === '/v1/status') return { data: { version: 'v1', refresh: [{ lane: 'catalog', finished_at: '2026-11-19T03:00:00Z', rows: 40000 }] } };
    return undefined;
  });
  try {
    const result = await tools.get('atcg_get_coverage').handler({});
    const text = result.content[0].text;
    assert.match(text, /onepiece\s+One Piece Card Game\s+70\s+4000\s+120\s+3500\s+90\s+3900\s+0\s+2026-11-18/);
    assert.match(text, /CM = Cardmarket, quotes in EUR; TCGP = TCGplayer, quotes in USD/);
    assert.match(text, /Not served by this API today: pokemon, yugioh/);
    assert.match(text, /unknown to this version of the MCP server.*: newgame/);
    assert.match(text, /Last refresh: catalog 2026-11-19T03:00:00Z \(40000 rows\)/);
    assert.match(text, /No price history/);
    assert.equal(result.structuredContent.games.find((g) => g.id === 'onepiece').prices.TCGPLAYER.cards, 3900);
  } finally {
    await server.close();
  }
});

test('copertura senza chiave: i prezzi pubblici rispondono, i conteggi dicono perche mancano', async (t) => {
  const { server, tools } = registry(t, { key: '' });
  const seen = fakeApi(t, (u) => {
    if (u.pathname === '/v1/games') return Response.json(errorBody('MISSING_API_KEY', 'This endpoint requires an API key.'), { status: 401 });
    if (u.pathname === '/v1/prices/coverage') return { data: [{ game: 'riftbound', source: 'TCGPLAYER', cards: 700, sealed: 4, as_of: '2026-11-18' }] };
    if (u.pathname === '/v1/status') return { data: { version: 'v1', refresh: [] } };
    return undefined;
  });
  try {
    const result = await tools.get('atcg_get_coverage').handler({ game: 'riftbound' });
    assert.equal(seen.find((s) => s.path === '/v1/games').headers['x-api-key'], undefined);
    const text = result.content[0].text;
    assert.match(text, /GET \/v1\/games answered MISSING_API_KEY\. ALLTCG_API_KEY is not set/);
    assert.match(text, /riftbound\s+Riftbound\s+—\s+—\s+—\s+700\s+4\s+2026-11-18/);
    assert.equal(result.structuredContent.games.length, 1);
  } finally {
    await server.close();
  }
});

test('scansione: un 429 breve a meta strada si aspetta e si riprova una volta, senza buttare le pagine pagate', async (t) => {
  const { server, tools } = registry(t);
  let refusals = 0;
  const seen = fakeApi(t, (u) => {
    if (u.searchParams.get('cursor') === null) return page([sealed('b0000000-0000-4000-8000-000000000001', 'Starter Deck', ['en'])], 'https://api.alltcgapi.com/v1/sealed?cursor=p2');
    if (refusals === 0) {
      refusals += 1;
      return Response.json(errorBody('RATE_LIMITED', 'Rate limit exceeded: your plan allows 5 requests per second.'), { status: 429, headers: { 'retry-after': '0' } });
    }
    return page([sealed('b0000000-0000-4000-8000-000000000002', 'OP-11 Booster Box', ['en'])]);
  });
  try {
    const result = await tools.get('atcg_search_sealed').handler({ game: 'onepiece', name: 'booster box' });
    assert.equal(result.isError, undefined);
    assert.equal(seen.length, 3);
    assert.deepEqual(result.structuredContent.products.map((p) => p.name), ['OP-11 Booster Box']);
  } finally {
    await server.close();
  }
});

test('scansione: un 429 lungo (quota, non il secondo) torna com e, senza attese', async (t) => {
  const { server, tools } = registry(t);
  const seen = fakeApi(t, () => Response.json(errorBody('RATE_LIMITED', 'Rate limit exceeded: your plan allows 300 requests per minute.'), { status: 429, headers: { 'retry-after': '40' } }));
  try {
    const started = Date.now();
    const result = await tools.get('atcg_search_sealed').handler({ game: 'onepiece', name: 'box' });
    assert.equal(result.isError, true);
    assert.equal(seen.length, 1);
    assert.ok(Date.now() - started < 1000);
    assert.match(result.content[0].text, /Retry after 40 s\./);
  } finally {
    await server.close();
  }
});

test('scansione: otto pagine senza arrivare in fondo e con poche righe non si chiama «More rows available»', async (t) => {
  const { server, tools } = registry(t);
  let n = 0;
  const seen = fakeApi(t, () => {
    n += 1;
    const rows = [sealed(`b0000000-0000-4000-8000-00000000000${n}`, n === 3 ? 'OP-03 Booster Box' : 'Starter Deck', ['en'])];
    return page(rows, `https://api.alltcgapi.com/v1/sealed?cursor=p${n + 1}`);
  });
  try {
    const result = await tools.get('atcg_search_sealed').handler({ name: 'booster box' });
    assert.equal(seen.length, 8);
    const text = result.content[0].text;
    assert.doesNotMatch(text, /More rows available/);
    assert.match(text, /Scan stopped after 8 pages without reaching the end of the list; pass game and set or kind to narrow it\. Call again with cursor="p9" to continue\./);
    assert.equal(result.structuredContent.complete, false);
    assert.equal(result.structuredContent.next_cursor, 'p9');
  } finally {
    await server.close();
  }
});
