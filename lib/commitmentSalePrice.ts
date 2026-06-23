import { prisma } from '@/lib/db';

export async function recalcSalePrice(orderId: number) {
  const links = await prisma.orderCommitmentLink.findMany({
    where: { orderId },
    include: { commitment: { select: { price: true, commission: true } } },
  });

  if (links.length === 0) return;

  const total = links.reduce(
    (sum, l) => sum + (l.commitment.price + l.commitment.commission) * l.quantity,
    0,
  );

  await prisma.order.update({
    where: { id: orderId },
    data: { salePrice: Math.round(total * 100) / 100 },
  });
}
