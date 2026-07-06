import { prisma } from '@/lib/db';

export async function recalcBfmrSalePrice(orderId: number): Promise<number | null> {
  const links = await prisma.orderBfmrLink.findMany({
    where: { orderId },
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
