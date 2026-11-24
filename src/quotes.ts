import { day, table } from './render.js';

/** Una quotazione come la scrive `goapi/internal/prices` (writeQuote). */
export interface Quote {
  readonly source: string;
  readonly variant: string;
  readonly language: string;
  readonly condition: string | null;
  readonly printing: string | null;
  readonly region: string | null;
  /** `true` quando la fonte ha contato solo i venditori dell'Unione Europea. */
  readonly eu_only?: boolean;
  readonly price: { readonly amount: number; readonly currency: string };
  /** Un giorno, `YYYY-MM-DD` in UTC. */
  readonly as_of: string;
}

/** Cio' che si sa di una valuta in una risposta: mai un totale, mai una media. */
export interface CurrencySummary {
  readonly currency: string;
  readonly quotes: number;
  readonly sources: readonly string[];
  readonly newest_as_of: string;
  readonly oldest_as_of: string;
  /** Giorni interi fra la quotazione piu' recente e adesso. */
  readonly newest_age_days: number;
}

/** Oltre questa eta' la quotazione piu' recente si segnala a lettere. */
export const STALE_DAYS = 7;

const DAY_MS = 86_400_000;

/**
 * Il riassunto per valuta.
 *
 * Esiste perche' un modello davanti a dodici righe in due valute fa una cosa
 * sola se non lo si ferma: una media. Qui le valute restano separate fin dalla
 * struttura, e l'unica cosa che si calcola e' quanto e' vecchio il dato.
 */
export function summarize(quotes: readonly Quote[], now: number = Date.now()): CurrencySummary[] {
  const byCurrency = new Map<string, Quote[]>();
  for (const quote of quotes) {
    const list = byCurrency.get(quote.price.currency) ?? [];
    list.push(quote);
    byCurrency.set(quote.price.currency, list);
  }
  const out: CurrencySummary[] = [];
  for (const [currency, list] of byCurrency) {
    const dates = list.map((q) => q.as_of).sort();
    const newest = dates[dates.length - 1] ?? '';
    const oldest = dates[0] ?? '';
    const age = Math.max(0, Math.floor((now - Date.parse(newest)) / DAY_MS));
    out.push({
      currency,
      quotes: list.length,
      sources: [...new Set(list.map((q) => q.source))].sort(),
      newest_as_of: newest,
      oldest_as_of: oldest,
      newest_age_days: Number.isFinite(age) ? age : 0,
    });
  }
  // EUR prima di USD, poi il resto: l'ordine in cui il sito presenta i mercati.
  const rank = (c: string) => (c === 'EUR' ? 0 : c === 'USD' ? 1 : 2);
  return out.sort((a, b) => rank(a.currency) - rank(b.currency) || a.currency.localeCompare(b.currency));
}

function summaryLine(s: CurrencySummary): string {
  const stale = s.newest_age_days > STALE_DAYS ? ` — the newest is ${s.newest_age_days} days old, say so when quoting it` : '';
  const span = day(s.oldest_as_of) === day(s.newest_as_of)
    ? `as of ${day(s.newest_as_of)}`
    : `as of ${day(s.oldest_as_of)} to ${day(s.newest_as_of)}`;
  return `${s.currency}: ${s.quotes} quote${s.quotes === 1 ? '' : 's'} from ${s.sources.join(', ')}, ${span}${stale}.`;
}

/**
 * Le quotazioni in testo: prima il riassunto per valuta e il divieto di
 * sommarle, poi la tabella intera. I prezzi non si tagliano (render.ts).
 */
export function quotesText(quotes: readonly Quote[], now: number = Date.now()): string {
  if (quotes.length === 0) {
    return 'No current quote for this item from any source served by the API. That is not a missing item: the ' +
      'catalogue has it, and no source quotes it today.';
  }
  const summaries = summarize(quotes, now);
  const lines = summaries.map(summaryLine);
  if (summaries.length > 1) {
    lines.push(`Different currencies: report ${summaries.map((s) => s.currency).join(' and ')} separately, never as one figure.`);
  }
  // La colonna compare solo se serve: due righe uguali in tutto tranne che nel
  // prezzo sarebbero indistinguibili senza, e sempre presente costerebbe token
  // a ogni risposta in cui non dice niente.
  const euOnly = quotes.some((q) => q.eu_only === true);
  if (euOnly) lines.push('eu_only = yes: the source counted sellers in the European Union only.');
  return [
    ...lines,
    '',
    table(
      ['source', 'variant', 'price', 'cur', 'lang', 'condition', 'printing', 'region', ...(euOnly ? ['eu_only'] : []), 'as_of'],
      quotes.map((q) => [
        q.source,
        q.variant,
        q.price.amount,
        q.price.currency,
        q.language,
        q.condition,
        q.printing,
        q.region,
        ...(euOnly ? [q.eu_only === true ? 'yes' : 'no'] : []),
        day(q.as_of),
      ]),
    ),
  ].join('\n');
}
