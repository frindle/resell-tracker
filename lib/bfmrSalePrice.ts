import { prisma } from '@/lib/db';
import { BFMR_TERMINAL_STATUSES, BFMR_STATUS_RANK } from '@/lib/bfmr';

export async function recalcBfmrSalePrice(orderId: number): Promise<number | null> {
  // Cancelled/returned/closed reservations stay linked for record-keeping
  // (BfmrReservationLinker shows them with an X to unlink manually) but
  // must not count toward the order's dollar value — otherwise a
  // re-reserved item's value gets summed on top of the reservation it
  // replaced.
  const links = await prisma.orderBfmrLink.findMany({
    where: { orderId, reservation: { status: { notIn: [...BFMR_TERMINAL_STATUSES] } } },
    select: { value: true, quantity: true, reservation: { select: { status: true, totalPayout: true, qty: true } } },
  });

  if (links.length === 0) return null;

  // l.value (when set) is an ABSOLUTE total for that link, not a per-unit
  // rate (see BfmrReservationLinker.tsx, which prefills it with the raw
  // reservation.totalPayout) — so it must NOT be multiplied by quantity.
  // The fallback, however, needs a per-unit rate so that splitting a
  // reservation into multiple links doesn't have each link re-claim the
  // whole totalPayout.
  const total = links.reduce((sum, l) => {
    if (l.value != null) return sum + l.value;
    const rQty = l.reservation.qty || 1;
    const perUnit = (l.reservation.totalPayout ?? 0) / rQty;
    return sum + perUnit * l.quantity;
  }, 0);
  // "Paid" per the same lifecycle rank sync-orders uses (>= 5): paid,
  // payment_sent, complete, completed. Anything below that is expected but
  // not yet disbursed.
  const isPaid = links.every(l => (BFMR_STATUS_RANK[l.reservation.status] ?? 0) >= 5);

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
