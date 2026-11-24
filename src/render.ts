import { cursorOf } from './collect.js';

/**
 * Il budget di contesto.
 *
 * Questo file decide se un agente tiene il server caricato o lo toglie. Ogni
 * risposta che esce da uno strumento finisce nella finestra di contesto del
 * modello e ci resta per tutto il turno, quindi le regole sono tre:
 *
 * 1. **Tabelle, non JSON.** Una tabella allineata non ripete le chiavi a ogni
 *    riga, e i modelli la leggono con meno errori. Il JSON esatto va comunque
 *    in `structuredContent`, che il client puo' leggere senza che passi dal
 *    testo.
 * 2. **Il taglio si dichiara.** Se restano righe, la risposta lo dice e dice
 *    come prenderle. Un troncamento silenzioso fa concludere al modello di aver
 *    visto tutto.
 * 3. **I prezzi non si tagliano mai.** Sono poche righe e sono esattamente il
 *    motivo della chiamata.
 */

/** Tetto nostro, piu' basso di quello dell'API (250): 250 righe non sopravvivono a un contesto. */
export const MAX_ROWS = 50;

export function clampLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return 20;
  return Math.max(1, Math.min(Math.trunc(requested), MAX_ROWS));
}

type Cell = string | number | null | undefined;

function cell(value: Cell): string {
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}

/**
 * Tabella a larghezza fissa. Niente bordi in ASCII: le pipe costerebbero token
 * quanto una colonna in piu' e non aggiungono niente a chi non deve vederci una
 * griglia.
 */
export function table(headers: readonly string[], rows: readonly (readonly Cell[])[]): string {
  if (rows.length === 0) return 'No rows.';

  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => cell(row[index]).length)),
  );

  const line = (values: readonly Cell[]): string =>
    values
      .map((value, index) => cell(value).padEnd(widths[index] ?? 0))
      .join('  ')
      .trimEnd();

  return [line(headers), widths.map((width) => '-'.repeat(width)).join('  '), ...rows.map(line)].join('\n');
}

/**
 * La riga che si aggiunge in fondo quando la lista continua.
 *
 * Il cursore va ripetuto per intero: e' opaco e porta la firma
 * dell'ordinamento, quindi un modello che prova a ricostruirlo ottiene un
 * `INVALID_CURSOR`. Meglio spendere i token del cursore che una chiamata persa.
 * L'API non dice quante righe ci sono in tutto, e qui non si stima.
 */
export function moreLine(nextUrl: string | null | undefined): string {
  const cursor = cursorOf(nextUrl);
  if (cursor === undefined) return '';
  return `\n\nMore rows available. Call again with cursor="${cursor}".`;
}

/** La data di un `as_of`: il giorno basta a chi legge, e l'ora costa token. */
export function day(iso: string | null | undefined): string | null {
  if (iso === null || iso === undefined || iso === '') return null;
  return iso.slice(0, 10);
}
