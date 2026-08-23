// Pure arithmetic for OrderBfmrLink.value. No prisma import on purpose:
// BfmrReservationLinker is a client component and needs exactly the same
// numbers the server derives, while lib/bfmrSalePrice.ts and
// lib/orderReturns.ts both pull in the Prisma client.
//
// OrderBfmrLink.value is an ABSOLUTE total for that link's whole quantity,
// NOT a per-unit rate — the linker prefills it with the raw
// reservation.totalPayout (see the comment in lib/bfmrSalePrice.ts). Every
// helper here preserves that: a link's fair share of a reservation is
// payout-per-unit × link quantity, and value is never multiplied by
// quantity anywhere.

/** Cents-rounded, so comparisons don't trip over float noise. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * What a link's ABSOLUTE value would be if derived from the reservation's
 * current payout right now: the reservation's per-unit payout times the
 * link's quantity.
 */
export function expectedLinkValue(
  totalPayout: number | null | undefined,
  reservationQty: number | null | undefined,
  linkQuantity: number,
): number | null {
  if (totalPayout == null) return null;
  const rQty = reservationQty && reservationQty > 0 ? reservationQty : 1;
  return round2((totalPayout / rQty) * Math.max(0, linkQuantity));
}

/**
 * The dollar figure to SHOW for a link. Prefers the stored absolute value
 * (which the user may have hand-entered) and falls back to the link's
 * prorated share of the reservation — the same fallback recalcBfmrSalePrice
 * uses, so the UI never shows a number the payout math wouldn't produce.
 *
 * This exists because the linker used to render `reservation.totalPayout`
 * for every link: a 1-unit link peeled off a qty-2 / $2,190 reservation
 * displayed the full $2,190, implying that one unit was worth the whole
 * reservation.
 */
export function linkDisplayValue(
  link: { quantity: number; value: number | null },
  reservation: { qty: number; totalPayout: number | null },
): number | null {
  if (link.value != null) return link.value;
  return expectedLinkValue(reservation.totalPayout, reservation.qty, link.quantity);
}

export type LinkValueDivergence = {
  /** What the link currently claims (absolute, whole-link total). */
  actual: number;
  /** What the reservation's current payout says this link is worth. */
  expected: number;
  /** actual − expected. Negative = the order is undercounting. */
  delta: number;
};

/**
 * Divergence between a link's snapshotted `value` and the reservation's
 * CURRENT totalPayout share, or null when they agree (or when there's
 * nothing to compare).
 *
 * `value` is captured from reservation.totalPayout at link time and never
 * re-synced, so a BFMR revision silently changes the order's payout: on
 * order 880 a link held value=1460 against a reservation worth 2190, a $730
 * undercount that only read as correct because a duplicate link offset it.
 *
 * This reports the drift rather than rewriting it — a value can legitimately
 * differ from BFMR's because the user typed it. Correction is a deliberate
 * action in the linker UI.
 */
export function linkValueDivergence(
  link: { quantity: number; value: number | null },
  reservation: { qty: number; totalPayout: number | null },
): LinkValueDivergence | null {
  if (link.value == null) return null; // nothing snapshotted; the fallback already tracks the reservation
  const expected = expectedLinkValue(reservation.totalPayout, reservation.qty, link.quantity);
  if (expected == null) return null;
  const actual = round2(link.value);
  const delta = round2(actual - expected);
  // A cent of rounding drift is not a divergence.
  if (Math.abs(delta) < 0.01) return null;
  return { actual, expected, delta };
}
