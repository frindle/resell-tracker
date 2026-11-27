// CSV writer for the report exports. Text cells that start with = + - @ tab or CR get a leading apostrophe so a
// spreadsheet never runs them as a formula (an order memo or vendor name is user text). Numbers, and strings that are
// a plain decimal number such as a negative amount ("-1234.50"), are never touched: they cannot run as a formula.
export type CsvCell = string | number | null | undefined;

const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

function cell(v: CsvCell): string {
  if (v == null) return '';
  let s = typeof v === 'number' ? String(v) : v;
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(head: string[], rows: CsvCell[][]): string {
  return [head, ...rows].map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
