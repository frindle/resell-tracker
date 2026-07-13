import { prisma } from '@/lib/db';
import { BFMR_TERMINAL_STATUSES } from '@/lib/bfmr';

export async function recalcBfmrSalePrice(orderId: number): Promise<number | null> {
  // Cancelled/returned/closed reservations stay linked for record-keeping
  // (BfmrReservationLinker shows them with an X to unlink manually) but
  // must not count toward the order's dollar value — otherwise a
  // re-reserved item's value gets summed on top of the reservation it
  // replaced.
  const links = await prisma.orderBfmrLink.findMany({
    where: { orderId, reservation: { status: { notIn: [...BFMR_TERMINAL_STATUSES] } } },
    select: { value: true, quantity: true, reservation: { select: { totalPayout: true } } },
  });

  if (links.length === 0) return null;

  const total = links.reduce((sum, l) => {
    const perUnit = l.value ?? l.reservation.totalPayout ?? 0;
    return sum + perUnit;
  }, 0);

  const salePrice = Math.round(total * 100) / 100;
  await prisma.order.updateMany({
    where: { id: orderId, locked: false },
    data: { salePrice },
  });
  return salePrice;
}
