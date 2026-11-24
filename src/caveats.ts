/**
 * Le avvertenze che devono comparire IDENTICHE ovunque.
 *
 * Una descrizione di strumento MCP e' l'unico canale in cui mettiamo parole
 * nostre dentro la memoria di lavoro di un modello, a ogni sessione. Vanno
 * scritte una volta sola e riusate: se la descrizione di un prezzo dice una
 * cosa e quella di un'altra rotta un'altra, il modello si fida della piu'
 * recente e sbaglia.
 *
 * Descrivono cio' che `goapi` fa oggi (`internal/prices`, `internal/catalog`).
 * Quando il servizio cambia, si cambia QUI.
 */

/**
 * La regola che conta di piu': due valute, mai sommate. Un agente a cui si
 * chiede «quanto vale» tende a dare un numero solo, e il modo piu' rapido di
 * produrlo e' fare la media fra un euro e un dollaro.
 */
export const CURRENCY_CAVEAT =
  'Cardmarket quotes are in EUR and TCGplayer quotes in USD. Nothing is converted: never add, average or ' +
  'compare a EUR figure with a USD figure as if they were one number. Report each market separately, with its ' +
  'currency.';

export const DATE_CAVEAT =
  'Every quote carries as_of, the day (UTC) the source last quoted it. Quotes are current, not live: the API ' +
  'serves each source about a day behind, some quotes are older, and the result says how old the newest one ' +
  'is. Never quote a price without its source and its as_of date.';

export const VARIANT_CAVEAT =
  'variant says what the number measures: LOWEST_NEAR_MINT is the lowest asking price for a near mint copy, ' +
  'LOWEST the lowest asking price in any condition (sealed products), TREND the trend price published by the ' +
  'source, AVG_7D and AVG_30D the average sale price over 7 or 30 days, MARKET the TCGplayer market price based ' +
  'on recent sales. An asking price is an offer, not a sale: say which one you quote.';

export const ROW_CAVEAT =
  'One item usually has several quotes: per source, per variant, per language of the copy, and on TCGplayer per ' +
  'printing (NORMAL, HOLOFOIL, …). Read language, condition and printing on the row you quote rather than taking ' +
  'the first number, and say which row it is. An empty list means no source quotes the item today, not that it ' +
  'does not exist.';

export const PRICE_CAVEAT = [CURRENCY_CAVEAT, DATE_CAVEAT, VARIANT_CAVEAT, ROW_CAVEAT].join(' ');

/**
 * La ricerca per nome dell'API e' un PREFISSO senza distinzione di maiuscole
 * (`internal/catalog/store.go`, `lower(c.name) LIKE 'x%'`), ordinato per id.
 * Un modello che non lo sa cerca «Dark Charizard» come «charizard dark», non
 * trova niente e conclude che la carta non c'e'.
 */
export const NAME_SEARCH_CAVEAT =
  'name matches the START of the card name, ignoring case: "charizard" finds "Charizard ex" but not ' +
  '"Dark Charizard", and spelling, accents and punctuation must match the printed name. If nothing comes back, ' +
  'retry with a shorter prefix (the first word) before concluding the card is missing. Rows come back in id ' +
  'order, not by release date or relevance: narrow with game, set or number rather than paging through a ' +
  'common name.';

/**
 * Cio' che da questi strumenti NON si ottiene. Lo restituisce
 * `atcg_get_coverage`, e una parte sta nelle descrizioni: un agente deve
 * saperlo prima di chiamare, non dopo. La prima voce e' un limite di questo
 * server (l'API lo storico lo serve); le altre sono limiti dell'API.
 */
export const NOT_PRESENT = [
  'No price history through these tools: they return only the latest quote of each series. The REST API ' +
    'serves the history of a card or a sealed product; this server has no tool for it yet.',
  'No graded prices (PSA, BGS, CGC and the like).',
  'No currency conversion: EUR stays EUR and USD stays USD.',
  'No individual listings, sellers or stock counts.',
  'No photo recognition: a card cannot be identified from an image here.',
  'No rules text search and no deck legality: attributes carry what each game publishes, unevenly.',
  'Card name search is a prefix match, not full text.',
];
