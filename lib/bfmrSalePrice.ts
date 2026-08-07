import { prisma } from '@/lib/db';
import { BFMR_TERMINAL_STATUSES, BFMR_STATUS_RANK } from '@/lib/bfmr';
import { returnedUnitsByLine, proratedLinkValue } from '@/lib/orderReturns';

export async function recalcBfmrSalePrice(orderId: number): Promise<number | null> {
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
  await prisma.order.updateMany({
    where: { id: orderId, locked: false },
    data: {
      salePrice,
      bgExpectedPayout: salePrice,
      bgPaidAmount: isPaid ? salePrice : null,
    },
  });
  return salePrice;
}
