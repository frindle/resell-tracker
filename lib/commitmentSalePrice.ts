import { prisma } from '@/lib/db';
import { returnedUnitsByLine } from '@/lib/orderReturns';

export async function recalcSalePrice(orderId: number): Promise<number | null> {
  const links = await prisma.orderCommitmentLink.findMany({
    where: { orderId },
    include: { commitment: { select: { id: true, price: true, commission: true } } },
  });
  // Returned / rejected units aren't sold — net them out of the line qty.
  const returned = await returnedUnitsByLine(orderId);
  const soldQty = (l: { id: number; quantity: number }) =>
    Math.max(0, l.quantity - (returned.get(`commit:${l.id}`) ?? 0));

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
    (sum, l) => sum + (l.commitment.price + l.commitment.commission) * soldQty(l),
    0,
  );
  const rounded = Math.round(total * 100) / 100;

  const breakdown = links.map(l => {
    const q = soldQty(l);
    const back = l.quantity - q;
    return `c${l.commitment.id}×${q}${back > 0 ? `(−${back} returned)` : ''}=$${((l.commitment.price + l.commitment.commission) * q).toFixed(2)}`;
  }).join(', ');

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
