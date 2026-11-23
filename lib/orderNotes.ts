// Dated one-line notes the email import writes into Order.notes. Pure, and
// idempotent: the same note is never added twice, so a re-read email or a
// re-run backfill changes nothing.

const TOTAL_PREFIX = 'Cancelled order total: ';
const DELAY_PREFIX = 'Delayed ';

export function addLine(notes: string | null | undefined, line: string): string {
  const cur = String(notes ?? '').trim();
  if (cur.split('\n').some(l => l.trim() === line)) return cur;
  return cur ? `${cur}\n${line}` : line;
}

/**
 * cancelOrder zeroes an order's money fields so it stays out of P&L; this keeps
 * what the order really cost visible. One total per order: a later one is ignored.
 */
export function withCancelledTotal(notes: string | null | undefined, total: number): string | null {
  const cur = String(notes ?? '').trim();
  if (!(total > 0) || hasCancelledTotal(cur)) return cur || null;
  return addLine(cur, `${TOTAL_PREFIX}$${total.toFixed(2)}`);
}

export function hasCancelledTotal(notes: string | null | undefined): boolean {
  return String(notes ?? '').split('\n').some(l => l.trim().startsWith(TOTAL_PREFIX));
}

/** "Delayed 2026-11-19: now arriving ...", dated by the email. */
export function delayNoteLine(emailDate: string, estimate: string): string {
  const d = new Date(emailDate);
  const day = Number.isNaN(d.getTime()) ? 'date unknown' : d.toISOString().slice(0, 10);
  const est = estimate.replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${DELAY_PREFIX}${day}${est ? `: now arriving ${est}` : ''}`;
}

export function withDelayNote(notes: string | null | undefined, emailDate: string, estimate: string): string {
  return addLine(notes, delayNoteLine(emailDate, estimate));
}

/**
 * What a re-read of an already-cancelled order may change in its money fields:
 * nothing. A cancelled order's cost stays zero (it is out of P&L) and the
 * total the page or email shows goes into the notes instead.
 */
export function cancelledOrderMoney(
  existing: { cost: number | null; shippingCost: number | null; cashbackAmount: number; salePrice: number | null; notes: string | null },
  incomingCost: number,
) {
  return {
    cost: existing.cost ?? 0,
    shippingCost: existing.shippingCost ?? 0,
    cashbackAmount: existing.cashbackAmount,
    salePrice: existing.salePrice,
    notes: withCancelledTotal(existing.notes, incomingCost),
  };
}
