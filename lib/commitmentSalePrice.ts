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

  // updateMany so we can scope by locked=false. A locked order keeps the
  // user's manual sale price even when commitment links change.
  await prisma.order.updateMany({
    where: { id: orderId, locked: false },
    data: { salePrice: Math.round(total * 100) / 100 },
  });
}
