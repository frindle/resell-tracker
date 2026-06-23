import { prisma } from '@/lib/db';

export async function recalcBfmrSalePrice(orderId: number) {
  const links = await prisma.orderBfmrLink.findMany({
    where: { orderId },
    select: { value: true, quantity: true, reservation: { select: { totalPayout: true } } },
  });

  if (links.length === 0) return;

  const total = links.reduce((sum, l) => {
    const perUnit = l.value ?? l.reservation.totalPayout ?? 0;
    return sum + perUnit;
  }, 0);

  // updateMany scoped by locked=false so a manually-set sale price on a
  // locked order isn't overwritten when reservation links change.
  await prisma.order.updateMany({
    where: { id: orderId, locked: false },
    data: { salePrice: Math.round(total * 100) / 100 },
  });
}
