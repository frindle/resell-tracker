import { prisma } from '@/lib/db';
import { BFMR_TERMINAL_STATUSES, BFMR_STATUS_RANK } from '@/lib/bfmr';
import { returnedUnitsByLine, proratedLinkValue } from '@/lib/orderReturns';
import { linkValueDivergence } from '@/lib/bfmrLinkValue';

export type StaleLinkValue = {
  linkId: number;
  orderId: number;
  reservationId: number;
  reserveId: string | null;
  linkQuantity: number;
  reservationQty: number;
  /** The link's stored (absolute) value. */
  actual: number;
  /** The reservation's current payout share for this link's quantity. */
  expected: number;
  /** actual − expected. Negative means the order is undercounting. */
  delta: number;
};

/**
 * Links whose snapshotted `value` no longer agrees with their reservation's
 * current totalPayout.
 *
 * `value` is captured from reservation.totalPayout when the link is created
 * (see bfmrAutoLink / BfmrReservationLinker) and never re-synced, while
 * recalcBfmrSalePrice below sums those snapshots — so when BFMR revises a
 * reservation the order's payout goes quietly wrong. Order 880: link 139
 * held value=1460 against a reservation worth 2190, a $730 undercount that
 * only read as correct because a duplicate link happened to offset it.
 *
 * This REPORTS the drift instead of rewriting it. A value that differs from
 * BFMR's is not necessarily wrong — the field is user-editable and people
 * hand-enter corrections into it — so silently re-deriving it would destroy
 * real data to fix a display problem. The linker shows each divergence with
 * a one-click "use the reservation's number" button, and this function backs
 * the sync route's summary count.
 */
export async function findStaleBfmrLinkValues(userId: number | null): Promise<StaleLinkValue[]> {
  const links = await prisma.orderBfmrLink.findMany({
    where: {
      value: { not: null },
      reservation: { userId, status: { notIn: [...BFMR_TERMINAL_STATUSES] } },
    },
    select: {
      id: true,
      orderId: true,
      quantity: true,
      value: true,
      reservationId: true,
      reservation: { select: { reserveId: true, qty: true, totalPayout: true } },
    },
  });

  const stale: StaleLinkValue[] = [];
  for (const l of links) {
    const d = linkValueDivergence(l, l.reservation);
    if (!d) continue;
    stale.push({
      linkId: l.id,
      orderId: l.orderId,
      reservationId: l.reservationId,
      reserveId: l.reservation.reserveId,
      linkQuantity: l.quantity,
      reservationQty: l.reservation.qty,
      actual: d.actual,
      expected: d.expected,
      delta: d.delta,
    });
  }
  return stale;
}

export async function recalcBfmrSalePrice(orderId: number): Promise<number | null> {
  // A cancelled order must not inherit paid/group status from whatever its
  // linked BFMR reservation's status happens to be -- BFMR_TERMINAL_STATUSES
  // below only checks the reservation's own lifecycle, not the local order's
  // cancelled flag, so without this check a cancelled-but-still-linked order
  // kept showing as paid/grouped (real case: order 877, cancelled, never
  // shipped, never paid, but showed a group and paid amount from its link).
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { cancelled: true } });
  if (order?.cancelled) {
    await prisma.order.updateMany({
      where: { id: orderId },
      data: { salePrice: null, bgExpectedPayout: null, bgPaidAmount: null },
    });
    return null;
  }

  // Cancelled/returned/closed reservations stay linked for record-keeping
  // (BfmrReservationLinker shows them with an X to unlink manually) but
  // must not count toward the order's dollar value — otherwise a
  // re-reserved item's value gets summed on top of the reservation it
  // replaced.
  const links = await prisma.orderBfmrLink.findMany({
    where: { orderId, reservation: { status: { notIn: [...BFMR_TERMINAL_STATUSES] } } },
    select: { id: true, value: true, quantity: true, reservation: { select: { status: true, totalPayout: true, qty: true } } },
  });

  if (links.length === 0) return null;

  // Units returned (or rejected and heading back) are not sold. Subtract them
  // per link so a partial return prorates the line instead of the old
  // all-or-nothing behaviour, where 1 of 3 units coming back still left the
  // full 3-unit payout on the order.
  const returned = await returnedUnitsByLine(orderId);

  // Breadcrumb for the stale-snapshot problem described on
  // findStaleBfmrLinkValues: the sum below trusts l.value, so if a snapshot
  // has drifted from BFMR the resulting salePrice is wrong and nothing else
  // in the pipeline would say so.
  for (const l of links) {
    const d = linkValueDivergence(l, l.reservation);
    if (d) {
      console.warn(
        `[bfmr/salePrice] order ${orderId} link ${l.id}: value ${d.actual} diverges from reservation payout share ${d.expected} (delta ${d.delta}) — salePrice below uses the stored value`,
      );
    }
  }

  // l.value (when set) is an ABSOLUTE total for that link, not a per-unit
  // rate (see BfmrReservationLinker.tsx, which prefills it with the raw
  // reservation.totalPayout) — so it must NOT be multiplied by quantity.
  // The fallback, however, needs a per-unit rate so that splitting a
  // reservation into multiple links doesn't have each link re-claim the
  // whole totalPayout.
  const total = links.reduce((sum, l) => {
    const soldQty = Math.max(0, l.quantity - (returned.get(`bfmr:${l.id}`) ?? 0));
    if (soldQty === 0) return sum;
    if (l.value != null) return sum + proratedLinkValue(l.value, l.quantity, soldQty);
    const rQty = l.reservation.qty || 1;
    const perUnit = (l.reservation.totalPayout ?? 0) / rQty;
    return sum + perUnit * soldQty;
  }, 0);
  // "Paid" per the same lifecycle rank sync-orders uses (>= 5): paid,
  // payment_sent, complete, completed. Anything below that is expected but
  // not yet disbursed. Links whose units all came back are excluded — a
  // fully-returned line shouldn't hold the order out of "paid".
  const soldLinks = links.filter(l => l.quantity - (returned.get(`bfmr:${l.id}`) ?? 0) > 0);
  const isPaid = soldLinks.length > 0 && soldLinks.every(l => (BFMR_STATUS_RANK[l.reservation.status] ?? 0) >= 5);

  const salePrice = Math.round(total * 100) / 100;
  // No `locked: false` guard here, unlike the routine BFMR sync route --
  // every call site is a deliberate user action (recording/editing a
  // return, linking/splitting/auto-linking a reservation, a manual order
  // edit), never background polling. The lock exists to stop routine
  // syncs from clobbering manually-confirmed payment data; it must not
  // also block the correction a return itself is supposed to trigger --
  // that left an already-paid order's salePrice/bgPaidAmount frozen at
  // its pre-return value forever once locked (real case: order 832,
  // stuck showing the full 3-unit payout after a 1-unit return).
  await prisma.order.updateMany({
    where: { id: orderId },
    data: {
      salePrice,
      bgExpectedPayout: salePrice,
      bgPaidAmount: isPaid ? salePrice : null,
    },
  });
  return salePrice;
}
