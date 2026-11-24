import { createRequire } from 'node:module';
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { Api, ApiError, NetworkError, type Envelope, type Single } from './api.js';
import { NAME_SEARCH_CAVEAT, NOT_PRESENT, PRICE_CAVEAT } from './caveats.js';
import { collect, cursorOf, type Verdict } from './collect.js';
import { GAMES, GAME_IDS } from './games.js';
import { quotesText, summarize, type Quote } from './quotes.js';
import { MAX_ROWS, clampLimit, day, moreLine, table } from './render.js';

/**
 * Sette strumenti, non uno per rotta.
 *
 * `tools/list` sta nel contesto del modello a OGNI turno, quindi ogni schema
 * si paga anche nelle conversazioni che non toccano le carte; e uno strumento
 * per rotta costringe il modello a incatenare chiamate, con un punto in cui
 * sbagliare a ogni anello. Qui gli strumenti hanno la forma delle DOMANDE
 * («quanto vale questa carta», «quali set di One Piece sono usciti nel 2025»,
 * «questa API ha i prezzi di Lorcana?»), e i parametri sono enumerati dove
 * l'API rifiuterebbe un valore sbagliato: un enum e' un errore che il modello
 * non puo' commettere.
 *
 * Cio' che NON e' esposto, e perche':
 * - `/v1/sealed/{id}`: la riga della ricerca porta gia' tutto cio' che il
 *   dettaglio aggiunge (niente), e i prezzi stanno in `atcg_get_prices`;
 * - `/v1/me`, `/v1/billing/plans`: riguardano l'account, non le carte, e nel
 *   profilo `store` le directory vietano di parlare di piani;
 * - `/v1/reference`: due vocabolari (regioni e lingue) che stanno gia' negli
 *   schemi qui sotto.
 */

/** Solo cio' che esiste davvero. Un enum e' una promessa. */
const REGIONS = ['WEST', 'EAST'] as const;
/** Le fonti accese in `alltcgapi.price_source` (migrazione 0004). */
const SOURCES = ['CARDMARKET', 'TCGPLAYER'] as const;
const CURRENCIES = ['EUR', 'USD'] as const;

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Una carta come la scrive `goapi/internal/catalog/render.go` (writeCard). */
export interface CardRow {
  readonly id: string;
  readonly game: string;
  readonly set: { readonly id: string; readonly code: string; readonly name: string };
  readonly number: string;
  readonly name: string;
  /** Solo nel dettaglio: `{ locale: nome }`. */
  readonly names?: Readonly<Record<string, string>>;
  readonly rarity: string | null;
  readonly supertype: string | null;
  readonly attributes: Readonly<Record<string, unknown>> | null;
  readonly image_url: string | null;
  readonly languages: readonly string[];
  readonly external_ids: { readonly cardmarket: number | null; readonly tcgplayer: number | null };
  readonly version: number;
  readonly updated_at: string;
}

export interface SetRow {
  readonly id: string;
  readonly game: string;
  readonly code: string;
  readonly slug: string | null;
  readonly name: string;
  readonly region: string;
  readonly release_date: string | null;
  readonly total_cards: number | null;
  readonly printed_cards: number | null;
  readonly image_url: string | null;
  readonly languages: readonly string[];
}

export interface SealedRow {
  readonly id: string;
  readonly game: string | null;
  readonly set: { readonly id: string; readonly code: string | null } | null;
  readonly sku: string;
  readonly kind: string;
  readonly name: string;
  readonly image_url: string | null;
  readonly release_date: string | null;
  readonly pack_count: number | null;
  readonly languages: readonly string[];
  readonly external_ids: { readonly cardmarket: number | null; readonly tcgplayer: number | null };
}

interface GameRow {
  readonly id: string;
  readonly name: string;
  readonly sets: number;
  readonly cards: number;
  readonly sealed: number;
}

interface CoverageRow {
  readonly game: string;
  readonly source: string;
  readonly cards: number;
  readonly sealed: number;
  readonly as_of: string;
}

interface StatusBody {
  readonly version: string;
  readonly refresh: readonly { readonly lane: string; readonly finished_at: string; readonly rows: number }[];
}

function textResult(text: string, structured: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text }], structuredContent: structured };
}

/** Un rifiuto deciso qui, prima di spendere una chiamata. */
function refuse(text: string) {
  return { isError: true, content: [{ type: 'text' as const, text }] };
}

const gameName = (id: string | null | undefined): string =>
  id === null || id === undefined ? '—' : (GAMES.find((g) => g.id === id)?.name ?? id);

/**
 * La riga di coda di una scansione: dice come continuare, o perche' non si
 * puo'. `narrow` e' il consiglio quando il limite si e' riempito a meta'
 * pagina; `more` e' cio' che potrebbe esserci oltre le pagine scorse.
 */
function scanTrailer(
  collected: { rows: readonly unknown[]; nextCursor: string | undefined; exhausted: boolean; truncatedMidPage: boolean; scannedPages: number },
  limit: number,
  narrow: string,
  more: string,
): string {
  if (collected.exhausted) return '';
  if (collected.truncatedMidPage) {
    return `

The row limit filled in the middle of a page, so there is no cursor to continue from: one here would skip the rest of that page. ${narrow}`;
  }
  const resume = collected.nextCursor === undefined ? '' : ` Call again with cursor="${collected.nextCursor}" to continue.`;
  // «More rows available» solo se il limite si e' riempito. Con poche righe e
  // le pagine finite, dirlo farebbe credere che le altre siano gia' trovate:
  // invece la scansione non e' arrivata in fondo, ed e' questo che va detto.
  if (collected.rows.length >= limit) return `

More rows available.${resume}`;
  return `

Scan stopped after ${collected.scannedPages} pages${more}${resume}`;
}

/**
 * Una data parziale si completa invece di rifiutarla: «2025» e' la domanda
 * piu' comune, e un modello la passa cosi'. Il confronto con `release_date`
 * e' fra stringhe ISO, quindi «2025-02-31» come limite superiore va bene.
 */
export function boundary(value: string | undefined, side: 'from' | 'to'): string | undefined | null {
  if (value === undefined || value.trim() === '') return undefined;
  const v = value.trim();
  if (/^\d{4}$/.test(v)) return side === 'from' ? `${v}-01-01` : `${v}-12-31`;
  if (/^\d{4}-\d{2}$/.test(v)) return side === 'from' ? `${v}-01` : `${v}-31`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return null;
}

/**
 * Il profilo decide cosa il server dice di soldi.
 *
 * `local` e' il pacchetto che uno installa con la propria chiave: i costi in
 * crediti sono informazione utile a chi paga. `store` e' il server remoto che
 * le directory di ChatGPT e di Claude elencano: li' le regole vietano a un
 * connettore di mostrare piani, prezzi del servizio, prove gratuite e link
 * d'acquisto, anche nelle descrizioni degli strumenti, e un rifiuto puo' solo
 * rimandare a una pagina informativa.
 */
export type Profile = 'local' | 'store';

export interface ServerOptions {
  /** Il client verso l'API. Senza, uno costruito dall'ambiente (ALLTCG_API_KEY). */
  readonly api?: Api;
  readonly profile?: Profile;
  /** L'orologio, per l'eta' delle quotazioni. Solo i test lo cambiano. */
  readonly now?: () => number;
}

interface ErrorContext {
  readonly profile: Profile;
  readonly hasKey: boolean;
}

const localContext = (): ErrorContext => ({ profile: 'local', hasKey: (process.env['ALLTCG_API_KEY'] ?? '') !== '' });

/**
 * La pagina a cui rimanda un rifiuto nel profilo `store`: l'account di chi ha
 * collegato il server, dove si legge che cosa comprende e quanto ne resta.
 * Il testo del rifiuto continua a non nominare piani ne' prezzi.
 */
export const ACCOUNT_URL = 'https://alltcgapi.com/account';

/** I rifiuti che dipendono dal piano o dal consumo dell'account, non dalla richiesta. */
const COMMERCIAL_CODES = new Set([
  'TRIAL_EXPIRED',
  'QUOTA_EXCEEDED',
  'PLAN_REQUIRED',
  'UPGRADE_REQUIRED',
  'CARD_ALLOWANCE_EXCEEDED',
]);

/** Le chiavi di `details` che portano piani o link d'acquisto. */
const COMMERCIAL_DETAILS = new Set(['plan', 'plans', 'plans_url', 'next_step', 'checkout_url', 'portal_url', 'offers', 'upgrade']);

/**
 * Il messaggio dell'API dice «mandala come header X-Api-Key»: giusto per un
 * client HTTP, sbagliato qui. Un modello non puo' mettere header su questo
 * trasporto, e provando a farlo gira a vuoto invece di chiedere la sola cosa
 * che sblocca la situazione, cioe' una variabile nella configurazione.
 */
const MISSING_KEY_HELP = [
  'ALLTCG_API_KEY is not set for this MCP server. Every tool needs it; atcg_get_coverage still reports price coverage and refresh times without it, from public routes.',
  'This cannot be fixed from inside the conversation: it is an environment variable in the MCP client configuration.',
  'Ask the user to add it, then restart the client. The sign-up page creates the account and shows the key once:',
  'https://alltcgapi.com/free-api-key',
].join('\n');

function storeErrorText(error: ApiError): string {
  if (COMMERCIAL_CODES.has(error.code)) {
    return `${error.code}: the connected account does not include this, or has used up its allowance for the period. ` +
      `Tell the user as written and do not retry. Their account: ${ACCOUNT_URL}`;
  }
  const kept = Object.entries(error.details ?? {}).filter(([key]) => !COMMERCIAL_DETAILS.has(key));
  const detail = kept.length === 0 ? '' : `\n${JSON.stringify(Object.fromEntries(kept))}`;
  return `${error.message.replace(/\s*Choose a plan at \S+/g, '')}${retryLine(error)}${detail}`;
}

function retryLine(error: ApiError): string {
  return error.retryAfter === undefined ? '' : ` Retry after ${error.retryAfter} s.`;
}

/**
 * Un errore dell'API torna come `isError`, non come eccezione: il modello deve
 * poterlo leggere e correggersi da solo. `details.allowed` e simili sono la
 * parte utile (l'elenco dei giochi validi, delle fonti accese), quindi si
 * riportano invece di essere riassunti.
 */
export function errorResult(error: unknown, context: ErrorContext = localContext()) {
  if (error instanceof ApiError) {
    if (context.profile === 'store') return refuse(storeErrorText(error));
    // Vuota, non solo assente: `"env": {"ALLTCG_API_KEY": ""}` e un segnaposto
    // non espanso sono il modo piu' comune di sbagliare la configurazione.
    if (error.code === 'MISSING_API_KEY' && !context.hasKey) return refuse(MISSING_KEY_HELP);
    const detail = error.details === undefined ? '' : `\n${JSON.stringify(error.details)}`;
    // `error.message` porta gia' il codice davanti (vedi ApiError).
    return refuse(`${error.message}${retryLine(error)}${detail}`);
  }
  if (error instanceof NetworkError) {
    // L'indirizzo solo nel profilo locale: sul server ospitato e' il nome di
    // un container, che a chi chiama non serve e non va mostrato.
    return refuse(context.profile === 'store'
      ? `${error.message} Retry once; if it fails again, tell the user the service is not answering.`
      : `${error.message} Base URL: ${error.baseUrl}. Check ALLTCG_BASE_URL in the MCP client configuration, or the network.`);
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return refuse('The API did not answer within 20 seconds. Retry once; if it fails again, tell the user the service is not answering.');
  }
  return refuse(error instanceof Error ? error.message : String(error));
}

/**
 * La versione che il server dichiara nell'`initialize` viene dal manifesto, non
 * da una costante: un valore da aggiornare a mano in due posti si disallinea, e
 * la versione e' l'unico dato con cui chi apre una segnalazione dice quale
 * build sta usando.
 *
 * `createRequire` invece di un import JSON perche' il file sta FUORI da
 * `rootDir`: da `dist/server.js` come da `src/server.ts` il percorso relativo
 * e' lo stesso.
 */
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

const LOCAL_HANDOFF =
  ' If a call is refused with TRIAL_EXPIRED or QUOTA_EXCEEDED, tell the user as written and do not retry; ' +
  'RATE_LIMITED says how many seconds to wait.';
const STORE_HANDOFF =
  ' If a call is refused because the connected account does not include it, tell the user as written and do not retry.';

export const TOOL_NAMES = [
  'atcg_search_cards',
  'atcg_get_card',
  'atcg_list_sets',
  'atcg_list_set_cards',
  'atcg_search_sealed',
  'atcg_get_prices',
  'atcg_get_coverage',
] as const;

export function createServer(options: ServerOptions = {}): McpServer {
  // Il client e' di QUESTA istanza, non del modulo: sul trasporto HTTP ogni
  // richiesta arriva con la credenziale di un utente diverso, e un client
  // condiviso addebiterebbe a uno le chiamate di un altro.
  const api = options.api ?? new Api();
  const profile: Profile = options.profile ?? 'local';
  const now = options.now ?? Date.now;
  const store = profile === 'store';
  const fail = (error: unknown) => errorResult(error, { profile, hasKey: api.hasKey });
  const handoff = store ? STORE_HANDOFF : LOCAL_HANDOFF;
  /** Testo che parla di crediti: nel profilo `store` si sostituisce o cade. */
  const paid = (local: string, inStore = ''): string => (store ? inStore : local);
  // Nel profilo `store` il mondo e' dichiarato chiuso: gli strumenti leggono un
  // catalogo delimitato, ed e' la lettura che la directory di ChatGPT chiede.
  const readOnly = { ...READ_ONLY, openWorldHint: !store };

  const server = new McpServer({ name: 'alltcgapi', version }, { capabilities: { tools: {} } });

  const gameSchema = {
    type: 'string',
    enum: [...GAME_IDS],
    description: 'Game id. Leave it out to read across every game.',
  };
  const limitSchema = { type: 'integer', minimum: 1, maximum: MAX_ROWS, description: `Rows, capped at ${MAX_ROWS}. Default 20.` };
  const cursorSchema = { type: 'string', description: 'Opaque cursor from a previous call with the same filters. Never construct one.' };
  const uuidHelp = (what: string, from: string) =>
    `${what} ids are UUIDs, e.g. "01d3a5f3-18df-4520-ac0b-4449c077f179". Find one with ${from}.`;

  // ── 1 · ricerca carte ─────────────────────────────────────────────────────
  server.registerTool(
    'atcg_search_cards',
    {
      title: 'Search cards',
      description:
        'Search trading cards by name or collector number, in one game or across every game the API serves. ' +
        'Returns one row per card with its id, game, set, number and rarity; pass the id to atcg_get_card or ' +
        'atcg_get_prices. ' +
        NAME_SEARCH_CAVEAT +
        paid(' 1 credit per call (up to 50 rows).') +
        handoff,
      annotations: readOnly,
      inputSchema: fromJsonSchema<{
        name?: string;
        number?: string;
        game?: string;
        set?: string;
        limit?: number;
        cursor?: string;
      }>({
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The start of the card name, e.g. "charizard", "monkey.d", "elsa".' },
          number: {
            type: 'string',
            description: 'Collector number exactly as the catalogue writes it, e.g. "OP11-095" for One Piece. Read the format off a search row rather than guessing.',
          },
          game: gameSchema,
          set: { type: 'string', description: 'Set code or set id from atcg_list_sets, e.g. "OP11".' },
          limit: limitSchema,
          cursor: cursorSchema,
        },
        additionalProperties: false,
      }),
    },
    async (args) => {
      const name = args.name?.trim() ?? '';
      const number = args.number?.trim() ?? '';
      const set = args.set?.trim() ?? '';
      if (name === '' && number === '' && set === '' && args.cursor === undefined) {
        return refuse('Give at least one of name, number or set: without a filter this is the whole catalogue in id order, which answers nothing.');
      }
      try {
        const body = await api.get<Envelope<CardRow>>('/v1/cards', {
          game: args.game,
          set,
          name,
          number,
          limit: clampLimit(args.limit),
          cursor: args.cursor,
        });
        const rows = body.data;
        let text =
          table(
            ['id', 'game', 'name', 'set', 'set name', 'number', 'rarity'],
            rows.map((c) => [c.id, c.game, c.name, c.set.code, c.set.name, c.number, c.rarity]),
          ) + moreLine(body.links?.next);
        if (rows.length === 0 && name !== '') {
          const first = name.split(/\s+/)[0] ?? name;
          text += `\n\nNo card name starts with "${name}"${args.game === undefined ? '' : ` in ${args.game}`}.` +
            (first !== name ? ` Retry with name="${first}" before concluding the card is missing.` : ' Check the spelling against the printed name.');
        }
        return textResult(text, { cards: rows, next_cursor: moreCursor(body.links?.next) });
      } catch (error) {
        return fail(error);
      }
    },
  );

  // ── 2 · dettaglio carta ───────────────────────────────────────────────────
  server.registerTool(
    'atcg_get_card',
    {
      title: 'Get one card',
      description:
        'One card by id: game, set, number, rarity, names in every language the catalogue holds, the game ' +
        'attributes it carries, the image URL and its Cardmarket and TCGplayer product ids. With ' +
        'include_prices it also returns every current quote in the same call. ' +
        paid('1 credit, plus 2 with include_prices. ') +
        'attributes are whatever the game publishes, unevenly filled: a missing attribute means we do not hold it, ' +
        'never that the card lacks it.' +
        handoff,
      annotations: readOnly,
      inputSchema: fromJsonSchema<{ id: string; include_prices?: boolean }>({
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Card id (a UUID) from atcg_search_cards or atcg_list_set_cards.' },
          include_prices: { type: 'boolean', description: 'Also return the current quotes of the card.' },
        },
        required: ['id'],
        additionalProperties: false,
      }),
    },
    async (args) => {
      const id = args.id.trim();
      if (!UUID.test(id)) return refuse(uuidHelp('Card', 'atcg_search_cards, by name or number'));
      try {
        const [card, prices] = await Promise.all([
          api.get<Single<CardRow>>(`/v1/cards/${id}`),
          args.include_prices === true ? api.get<{ data: Quote[] }>(`/v1/cards/${id}/prices`) : Promise.resolve(undefined),
        ]);
        const c = card.data;
        const names = Object.entries(c.names ?? {});
        const attributes = c.attributes === null ? null : JSON.stringify(c.attributes);
        // Gli attributi di certi giochi portano il testo di gioco intero: si
        // taglia nel testo, e si dice, ma restano interi in structuredContent.
        const shown = attributes !== null && attributes.length > 1500 ? `${attributes.slice(0, 1500)}… (cut here; the full object is in the structured result)` : attributes;
        const lines = [
          `${c.name} — ${gameName(c.game)} (${c.game})`,
          `id ${c.id}`,
          `set ${c.set.code} ${c.set.name} (set id ${c.set.id})`,
          `number ${c.number} · rarity ${c.rarity ?? '—'} · supertype ${c.supertype ?? '—'}`,
          `languages ${c.languages.length === 0 ? '—' : c.languages.join(', ')}`,
          ...(names.length === 0 ? [] : [`names ${names.map(([locale, n]) => `${locale}: ${n}`).join(' · ')}`]),
          `attributes ${shown ?? '—'}`,
          `image ${c.image_url ?? '—'}`,
          `marketplace ids: cardmarket ${c.external_ids.cardmarket ?? '—'}, tcgplayer ${c.external_ids.tcgplayer ?? '—'}`,
        ];
        if (prices !== undefined) lines.push('', 'Current quotes:', quotesText(prices.data, now()));
        return textResult(lines.join('\n'), {
          card: c,
          ...(prices === undefined ? {} : { quotes: prices.data, by_currency: summarize(prices.data, now()) }),
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  // ── 3 · set ───────────────────────────────────────────────────────────────
  server.registerTool(
    'atcg_list_sets',
    {
      title: 'List sets',
      description:
        'Sets newest first, with code, name, game, print line, release date, card count and id. One call answers ' +
        '"every One Piece set released in 2025" or "which Lorcana set is called Azurite Sea". The print line is ' +
        'WEST (international) or EAST (Asian prints: Japanese, Chinese, Korean); an Asian set is its own row, not a ' +
        'translation of a Western one. name keeps sets whose name or code contains the text. ' +
        paid(
          '1 credit per page: a name or date filter reads pages of 250 and keeps the matching sets, up to 8 pages.',
          'A name or date filter reads the list page by page and keeps the matching sets.',
        ) +
        handoff,
      annotations: readOnly,
      inputSchema: fromJsonSchema<{
        game?: string;
        region?: string;
        name?: string;
        released_from?: string;
        released_to?: string;
        limit?: number;
        cursor?: string;
      }>({
        type: 'object',
        properties: {
          game: gameSchema,
          region: { type: 'string', enum: [...REGIONS], description: 'Print line of the set.' },
          name: { type: 'string', description: 'Text the set name or code contains, e.g. "azurite" or "OP11".' },
          released_from: { type: 'string', description: 'Inclusive lower bound on the release date: YYYY, YYYY-MM or YYYY-MM-DD.' },
          released_to: { type: 'string', description: 'Inclusive upper bound on the release date: YYYY, YYYY-MM or YYYY-MM-DD.' },
          limit: limitSchema,
          cursor: cursorSchema,
        },
        additionalProperties: false,
      }),
    },
    async (args) => {
      const from = boundary(args.released_from, 'from');
      const to = boundary(args.released_to, 'to');
      if (from === null || to === null) return refuse('released_from and released_to take YYYY, YYYY-MM or YYYY-MM-DD.');
      const name = args.name?.trim().toLowerCase() ?? '';
      const windowed = from !== undefined || to !== undefined;
      const filtering = windowed || name !== '';
      const limit = clampLimit(args.limit);
      try {
        const collected = await collect<SetRow>(
          (cursor) =>
            api.get<Envelope<SetRow>>('/v1/sets', {
              game: args.game,
              region: args.region,
              // Un set costa 1 credito a pagina qualunque sia la pagina: con un
              // filtro locale conviene leggerne 250 alla volta.
              limit: filtering ? 250 : limit,
              // `cursor ?? args.cursor`: quello locale vale dalla seconda pagina
              // in poi, ma la PRIMA richiesta parte da dove ha detto il chiamante.
              cursor: cursor ?? args.cursor,
            }),
          (set): Verdict => {
            if (windowed) {
              // L'API mette i set senza data in fondo: incontrato il primo,
              // tutti i successivi sono senza data, e nessuno sta in finestra.
              if (set.release_date === null) return 'stop';
              const released = set.release_date.slice(0, 10);
              if (to !== undefined && released > to) return 'skip';
              if (from !== undefined && released < from) return 'stop';
            }
            if (name !== '' && !set.name.toLowerCase().includes(name) && !set.code.toLowerCase().includes(name)) return 'skip';
            return 'keep';
          },
          limit,
        );
        const rows = collected.rows;
        const text =
          table(
            ['code', 'name', 'game', 'line', 'released', 'cards', 'id'],
            rows.map((s) => [s.code, s.name, s.game, s.region, day(s.release_date), s.total_cards ?? s.printed_cards, s.id]),
          ) +
          scanTrailer(collected, limit, 'Narrow with game, region or a tighter window, or raise limit.', '; there may be more matching sets.');
        return textResult(text, { sets: rows, complete: collected.exhausted, next_cursor: collected.nextCursor ?? null });
      } catch (error) {
        return fail(error);
      }
    },
  );

  // ── 4 · carte di un set ───────────────────────────────────────────────────
  server.registerTool(
    'atcg_list_set_cards',
    {
      title: 'List the cards of a set',
      description:
        'The cards of one set in collector-number order, by set id or code from atcg_list_sets. A set code can ' +
        'exist in more than one game: pass the set id to be exact, and check the game on the first line of the ' +
        'result. name (start of the card name) and number narrow the list. ' +
        paid('1 credit per call (up to 50 rows).') +
        handoff,
      annotations: readOnly,
      inputSchema: fromJsonSchema<{ set: string; name?: string; number?: string; limit?: number; cursor?: string }>({
        type: 'object',
        properties: {
          set: { type: 'string', description: 'Set id (UUID) or set code, e.g. "OP11".' },
          name: { type: 'string', description: 'The start of the card name.' },
          number: { type: 'string', description: 'Collector number exactly as the catalogue writes it.' },
          limit: limitSchema,
          cursor: cursorSchema,
        },
        required: ['set'],
        additionalProperties: false,
      }),
    },
    async (args) => {
      const set = args.set.trim();
      if (set === '') return refuse('set is required: a set id or code from atcg_list_sets.');
      try {
        const body = await api.get<Envelope<CardRow>>(`/v1/sets/${encodeURIComponent(set)}/cards`, {
          name: args.name?.trim(),
          number: args.number?.trim(),
          limit: clampLimit(args.limit),
          cursor: args.cursor,
        });
        const rows = body.data;
        const first = rows[0];
        const head = first === undefined ? '' : `Set ${first.set.code} — ${first.set.name} (${first.game}, set id ${first.set.id})\n\n`;
        const text =
          head +
          table(['id', 'number', 'name', 'rarity'], rows.map((c) => [c.id, c.number, c.name, c.rarity])) +
          moreLine(body.links?.next);
        return textResult(text, { cards: rows, next_cursor: moreCursor(body.links?.next) });
      } catch (error) {
        return fail(error);
      }
    },
  );

  // ── 5 · sigillati ─────────────────────────────────────────────────────────
  /**
   * La lista dei sigillati non filtra per nome ne' per lingua: `name` e
   * `language` scorrono pagine da 100 e tengono le righe che corrispondono,
   * con le garanzie di `collect` (il taglio si dichiara, il cursore solo a
   * pagina intera).
   */
  server.registerTool(
    'atcg_search_sealed',
    {
      title: 'Search sealed products',
      description:
        'Sealed products (booster boxes, booster packs, starter decks, tins, collections) of a game or a set, ' +
        'with kind, set, release date, pack count and the languages each product exists in. kind is the product ' +
        'kind as the catalogue writes it, e.g. BOOSTER_BOX, BOOSTER_PACK, ETB: read the values off a search ' +
        'rather than guessing, an unknown kind returns no rows. name keeps products whose name contains the text. ' +
        paid(
          '1 credit per 50 rows; a name or language filter reads pages of 100 (2 credits each) and keeps the matches, up to 8 pages. ',
          'A name or language filter reads the list page by page and keeps the matches. ',
        ) +
        'Quotes are a separate call: atcg_get_prices with type "sealed" and the id returned here.' +
        handoff,
      annotations: readOnly,
      inputSchema: fromJsonSchema<{
        game?: string;
        set?: string;
        kind?: string;
        name?: string;
        language?: string;
        limit?: number;
        cursor?: string;
      }>({
        type: 'object',
        properties: {
          game: gameSchema,
          set: { type: 'string', description: 'Set code or set id from atcg_list_sets.' },
          kind: { type: 'string', description: 'Product kind, e.g. BOOSTER_BOX.' },
          name: { type: 'string', description: 'Text the product name contains, e.g. "booster box".' },
          language: { type: 'string', description: 'Keep products that exist in this language code, e.g. "ja", "en".' },
          limit: limitSchema,
          cursor: cursorSchema,
        },
        additionalProperties: false,
      }),
    },
    async (args) => {
      const name = args.name?.trim().toLowerCase() ?? '';
      const language = args.language?.trim().toLowerCase() ?? '';
      const filtering = name !== '' || language !== '';
      const limit = clampLimit(args.limit);
      try {
        const collected = await collect<SealedRow>(
          (cursor) =>
            api.get<Envelope<SealedRow>>('/v1/sealed', {
              game: args.game,
              set: args.set?.trim(),
              kind: args.kind?.trim().toUpperCase(),
              limit: filtering ? 100 : limit,
              cursor: cursor ?? args.cursor,
            }),
          (p): Verdict => {
            if (name !== '' && !p.name.toLowerCase().includes(name) && p.sku.toLowerCase() !== name) return 'skip';
            if (language !== '' && !p.languages.includes(language)) return 'skip';
            return 'keep';
          },
          limit,
        );
        const rows = collected.rows;
        const text =
          table(
            ['id', 'name', 'kind', 'game', 'set', 'languages', 'released', 'packs'],
            rows.map((p) => [p.id, p.name, p.kind, p.game, p.set?.code, p.languages.join(','), day(p.release_date), p.pack_count]),
          ) +
          scanTrailer(
            collected,
            limit,
            'Narrow with game, set or kind, or raise limit.',
            ' without reaching the end of the list; pass game and set or kind to narrow it.',
          );
        return textResult(text, { products: rows, complete: collected.exhausted, next_cursor: collected.nextCursor ?? null });
      } catch (error) {
        return fail(error);
      }
    },
  );

  // ── 6 · prezzi ────────────────────────────────────────────────────────────
  server.registerTool(
    'atcg_get_prices',
    {
      title: 'Get current prices',
      description:
        'Every current quote for one card or one sealed product, by the id a search returned: source, variant, ' +
        'language of the copy, condition, printing, region, amount with its currency, and the as_of date. The ' +
        'result opens with one line per currency saying how many quotes and how recent. ' +
        PRICE_CAVEAT +
        ' Only the latest quote of each series: this tool has no price history, and the API has no graded prices.' +
        paid(' 2 credits per call.') +
        handoff,
      annotations: readOnly,
      inputSchema: fromJsonSchema<{ type: string; id: string; source?: string; language?: string; currency?: string }>({
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['card', 'sealed'], description: 'What the id is: a card or a sealed product.' },
          id: { type: 'string', description: 'The UUID from atcg_search_cards, atcg_list_set_cards or atcg_search_sealed.' },
          source: { type: 'string', enum: [...SOURCES], description: 'Keep one source.' },
          language: { type: 'string', description: 'Keep quotes for copies in this language code, e.g. "en", "ja".' },
          currency: {
            type: 'string',
            enum: [...CURRENCIES],
            description: 'Keep only quotes already in this currency. Nothing is ever converted.',
          },
        },
        required: ['type', 'id'],
        additionalProperties: false,
      }),
    },
    async (args) => {
      const id = args.id.trim();
      const sealed = args.type === 'sealed';
      if (!UUID.test(id)) {
        return refuse(uuidHelp(sealed ? 'Sealed product' : 'Card', sealed ? 'atcg_search_sealed' : 'atcg_search_cards, by name or number'));
      }
      try {
        const body = await api.get<{ data: Quote[] }>(`/v1/${sealed ? 'sealed' : 'cards'}/${id}/prices`, {
          source: args.source,
          language: args.language?.trim().toLowerCase(),
        });
        const all = body.data;
        const rows = args.currency === undefined ? all : all.filter((q) => q.price.currency === args.currency);
        const dropped = all.length - rows.length;
        const text =
          `Current quotes for ${sealed ? 'sealed product' : 'card'} ${id}:\n` +
          quotesText(rows, now()) +
          (dropped > 0 ? `\n\n${dropped} quote${dropped === 1 ? '' : 's'} in other currencies left out by currency=${args.currency}.` : '');
        return textResult(text, { type: sealed ? 'sealed' : 'card', id, quotes: rows, by_currency: summarize(rows, now()) });
      } catch (error) {
        return fail(error);
      }
    },
  );

  // ── 7 · copertura ─────────────────────────────────────────────────────────
  /**
   * Esiste perche' un modello a cui si chiede «questa API ha i prezzi di
   * Gundam?» altrimenti risponderebbe deducendolo da un enum o dal nome del
   * prodotto, cioe' inventando. Qui la risposta e' un fatto misurato da una
   * chiamata. Le due rotte dei prezzi e dello stato sono pubbliche: lo
   * strumento risponde a meta' anche senza chiave, e lo dice.
   */
  server.registerTool(
    'atcg_get_coverage',
    {
      title: 'What the API covers',
      description:
        'What the API covers, measured live: each game with its id and its set, card and sealed counts, how many ' +
        'cards and sealed products have a current quote from each source and how recent the newest is, when the ' +
        'catalogue was last refreshed, and what the API does not hold at all. Call this before telling a user what ' +
        'the API can or cannot answer, or which games have prices. ' +
        paid('1 credit for the game counts; price coverage and refresh times are public and answer even without a key.') +
        handoff,
      annotations: readOnly,
      inputSchema: fromJsonSchema<{ game?: string }>({
        type: 'object',
        properties: { game: { ...gameSchema, description: 'Report one game only.' } },
        additionalProperties: false,
      }),
    },
    async (args) => {
      const [gamesR, coverageR, statusR] = await Promise.allSettled([
        api.get<{ data: GameRow[] }>('/v1/games'),
        api.get<{ data: CoverageRow[] }>('/v1/prices/coverage'),
        api.get<Single<StatusBody>>('/v1/status'),
      ]);
      if (gamesR.status === 'rejected' && coverageR.status === 'rejected') return fail(gamesR.reason);

      const live = gamesR.status === 'fulfilled' ? gamesR.value.data : null;
      const coverage = coverageR.status === 'fulfilled' ? coverageR.value.data : [];
      const sources = [...new Set(coverage.map((c) => c.source))].sort();
      const short = (source: string) => (source === 'CARDMARKET' ? 'CM' : source === 'TCGPLAYER' ? 'TCGP' : source);

      // Senza /v1/games (niente chiave) l'elenco dei giochi e' quello di questo
      // pacchetto: i conteggi restano vuoti, la copertura prezzi no.
      const ids = live === null ? [...GAME_IDS] : live.map((g) => g.id);
      const wanted = args.game === undefined ? ids : ids.filter((id) => id === args.game);
      const games = wanted.map((id) => {
        const row = live?.find((g) => g.id === id);
        const prices = Object.fromEntries(
          coverage.filter((c) => c.game === id).map((c) => [c.source, { cards: c.cards, sealed: c.sealed, as_of: c.as_of }]),
        );
        return { id, name: row?.name ?? gameName(id), sets: row?.sets ?? null, cards: row?.cards ?? null, sealed: row?.sealed ?? null, prices };
      });

      const notInServer = live === null ? [] : live.filter((g) => !(GAME_IDS as readonly string[]).includes(g.id)).map((g) => g.id);
      const notServed = live === null ? [] : GAME_IDS.filter((id) => !live.some((g) => g.id === id));
      const refresh = statusR.status === 'fulfilled' ? statusR.value.data.refresh : [];

      const lines: string[] = [];
      if (live === null) {
        const reason = gamesR.status === 'rejected' && gamesR.reason instanceof ApiError ? gamesR.reason.code : 'an error';
        const keyHint = reason === 'MISSING_API_KEY' && !store
          ? ' ALLTCG_API_KEY is not set in the MCP client configuration; how to get a key: https://alltcgapi.com/free-api-key.'
          : '';
        lines.push(`Set, card and sealed counts are missing: GET /v1/games answered ${reason}.${keyHint} Price coverage below is public.`, '');
      }
      lines.push(
        table(
          ['game', 'name', 'sets', 'cards', 'sealed', ...sources.flatMap((s) => [`${short(s)} cards`, `${short(s)} sealed`]), 'newest quote'],
          games.map((g) => {
            const newest = Object.values(g.prices).map((p) => p.as_of).sort().pop();
            return [
              g.id, g.name, g.sets, g.cards, g.sealed,
              ...sources.flatMap((s) => [g.prices[s]?.cards ?? 0, g.prices[s]?.sealed ?? 0]),
              day(newest),
            ];
          }),
        ),
      );
      if (sources.length > 0) {
        lines.push('', `${sources.map((s) => `${short(s)} = ${s === 'CARDMARKET' ? 'Cardmarket, quotes in EUR' : s === 'TCGPLAYER' ? 'TCGplayer, quotes in USD' : s}`).join('; ')}. A 0 means no quote from that source for that game.`);
      } else if (coverageR.status === 'rejected') {
        lines.push('', 'Price coverage could not be read (GET /v1/prices/coverage failed).');
      }
      if (notServed.length > 0) lines.push('', `Not served by this API today: ${notServed.join(', ')}.`);
      if (notInServer.length > 0) lines.push('', `Also served, but unknown to this version of the MCP server (its game filter cannot select them): ${notInServer.join(', ')}.`);
      if (refresh.length > 0) {
        lines.push('', `Last refresh: ${refresh.map((r) => `${r.lane} ${r.finished_at} (${r.rows} rows)`).join('; ')}.`);
      }
      lines.push('', 'Not available through these tools:', ...NOT_PRESENT.map((line) => `- ${line}`));

      return textResult(lines.join('\n'), {
        measured_at: new Date(now()).toISOString(),
        games,
        refresh,
        not_served: notServed,
        not_in_this_server: notInServer,
        not_present: NOT_PRESENT,
      });
    },
  );

  return server;
}

function moreCursor(next: string | null | undefined): string | null {
  return cursorOf(next) ?? null;
}
