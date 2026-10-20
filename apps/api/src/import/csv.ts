/**
 * Minimal CSV reader and writer (RFC 4180 quoting). The legacy tabs hold currency strings with
 * commas ("৳17,500.00"), so fields are quoted whenever needed. No dependency on purpose.
 */

/** Parse CSV text into rows of cells. Blank lines become rows with one empty cell. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');

  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += c;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** A row that is empty or only blank cells. */
export const isBlankRow = (row: readonly string[]): boolean => row.every((c) => c.trim() === '');

/** Header row plus data rows to objects. Blank rows are skipped; missing cells are ''. */
export function csvObjects(text: string): Array<Record<string, string>> {
  const rows = parseCsv(text).filter((r) => !isBlankRow(r));
  const header = rows[0];
  if (!header) return [];
  const keys = header.map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ''])));
}

function escapeCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Rows to CSV text (LF line ends, trailing newline). */
export function toCsv(header: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  const lines = [header, ...rows].map((r) => r.map(escapeCell).join(','));
  return lines.join('\n') + '\n';
}
