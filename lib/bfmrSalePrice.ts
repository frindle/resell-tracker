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

  await prisma.order.update({
    where: { id: orderId },
    data: { salePrice: Math.round(total * 100) / 100 },
  });
}
