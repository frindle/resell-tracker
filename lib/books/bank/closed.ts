// Closed bank accounts: the bank closed it, but it was real and stays in the books. Pure rules, no database.
// closedOn is a 'YYYY-MM-DD' day (the last day the account was open). History, links and postings are never touched.

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Why `closedOn` cannot be set, or null when it can. `lastPostedDate` is the account's latest posted (non-pending) row. */
export function closedOnRefusal(closedOn: unknown, lastPostedDate: string | null): string | null {
  if (typeof closedOn !== 'string' || !DAY.test(closedOn)) return 'closedOn must be a date (YYYY-MM-DD) or null';
  const d = new Date(`${closedOn}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== closedOn) return 'closedOn is not a real date';
  if (lastPostedDate && closedOn < lastPostedDate) return `closedOn cannot be before the last posted transaction (${lastPostedDate})`;
  return null;
}

/** Is a month-end check (reconcile, missing statement, stale feed) due for `month` ('YYYY-MM')? Months after the close are skipped. */
export function checkDueForMonth(closedOn: string | null | undefined, month: string): boolean {
  return !closedOn || month <= closedOn.slice(0, 7);
}

/** A row dated after the account closed: kept, but held out of matching and flagged for review. */
export function isPostClose(closedOn: string | null | undefined, postedDate: string): boolean {
  return !!closedOn && postedDate > closedOn;
}

/**
 * What is left in a closed account: the last known balance, plus the settled rows posted after that balance's date, up to closedOn (later rows are held for review).
 * Returns cents, or null when no balance is known.
 */
export function leftoverCents(balanceCents: number | null, balanceDate: string | null, rows: { postedDate: string; amountCents: number; pending: boolean }[], closedOn: string | null = null): number | null {
  if (balanceCents == null) return null;
  let c = balanceCents;
  for (const r of rows) if (!r.pending && balanceDate != null && r.postedDate > balanceDate && !isPostClose(closedOn, r.postedDate)) c += r.amountCents;
  return c;
}

const usd = (c: number) => `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toFixed(2)}`;

/** The message for a closed account whose balance is not zero, or null when it is zero (or unknown). */
export function leftoverMessage(cents: number | null): string | null {
  if (cents == null || cents === 0) return null;
  return `closed with ${usd(cents)} left - record where it went`;
}

/** Closed accounts last (stable order otherwise), for pickers. */
export function closedLast<T extends { closedOn?: string | null }>(items: T[]): T[] {
  return [...items.filter(i => !i.closedOn), ...items.filter(i => i.closedOn)];
}
/** Picker label: the name, then "(closed)" for a closed account. */
export const closedLabel = (name: string, closedOn?: string | null) => (closedOn ? `${name} (closed)` : name);
