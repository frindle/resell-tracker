import { prisma } from '@/lib/db';

export async function recalcSalePrice(orderId: number): Promise<number | null> {
  const links = await prisma.orderCommitmentLink.findMany({
    where: { orderId },
    include: { commitment: { select: { id: true, price: true, commission: true } } },
  });

  if (links.length === 0) {
    const { count } = await prisma.order.updateMany({
      where: { id: orderId, locked: false, bgExpectedPayout: { not: null } },
      data: { bgExpectedPayout: 0 },
    });
    if (count > 0) {
      console.log(`[commit-recalc] order ${orderId}: no links, reset bgExpectedPayout → $0`);
    } else {
      console.log(`[commit-recalc] order ${orderId}: no links, nothing to reset`);
    }
    return null;
  }

  const total = links.reduce(
    (sum, l) => sum + (l.commitment.price + l.commitment.commission) * l.quantity,
    0,
  );
  const rounded = Math.round(total * 100) / 100;

  const breakdown = links.map(l => `c${l.commitment.id}×${l.quantity}=$${((l.commitment.price + l.commitment.commission) * l.quantity).toFixed(2)}`).join(', ');

  const { count } = await prisma.order.updateMany({
    where: { id: orderId, locked: false },
    data: { salePrice: rounded, bgExpectedPayout: rounded },
  });

  if (count === 0) {
    const o = await prisma.order.findUnique({ where: { id: orderId }, select: { locked: true, salePrice: true } });
    console.log(`[commit-recalc] order ${orderId}: write skipped (locked=${o?.locked}, currentSalePrice=${o?.salePrice}, would-be=$${rounded}, links=[${breakdown}])`);
  } else {
    console.log(`[commit-recalc] order ${orderId}: salePrice + bgExpectedPayout → $${rounded} (links=[${breakdown}])`);
  }

  return rounded;
}
