// One conversion from Float dollars to Int cents for the whole books layer.
// Reuses lib/loans.ts toCents (half away from zero with a 1e-9 nudge, so
// 1.005 -> 101 and -0.005 -> -1 even though 1.005 * 100 is 100.49999999999999).
import { toCents } from '../loans.ts';

export { toCents };

/** Dollars (null/undefined/NaN count as 0) to integer cents. */
export function cents(v: number | null | undefined): number {
  if (v == null) return 0;
  return toCents(v) ?? 0;
}

export function fmtCents(c: number): string {
  const sign = c < 0 ? '-' : '';
  const a = Math.abs(c);
  return `${sign}$${Math.floor(a / 100).toLocaleString('en-US')}.${String(a % 100).padStart(2, '0')}`;
}
