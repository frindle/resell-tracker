import { prisma } from '@/lib/db';
import { type LinkUnits } from '@/lib/commitmentUnits';

/** Every link on the commitments these orders are linked to (other orders' links included), and those commitments' counts. */
export async function loadCommitmentUnits(orderIds: number[]): Promise<{ links: LinkUnits[]; counts: Map<number, number> }> {
  if (!orderIds.length) return { links: [], counts: new Map() };
  const mine = await prisma.orderCommitmentLink.findMany({ where: { orderId: { in: orderIds } }, select: { commitmentId: true }, distinct: ['commitmentId'] });
  const ids = mine.map(l => l.commitmentId);
  if (!ids.length) return { links: [], counts: new Map() };
  const [links, commitments] = await Promise.all([
    prisma.orderCommitmentLink.findMany({ where: { commitmentId: { in: ids } }, select: { id: true, orderId: true, commitmentId: true, quantity: true } }),
    prisma.buyingGroupCommitment.findMany({ where: { id: { in: ids } }, select: { id: true, count: true } }),
  ]);
  return { links, counts: new Map(commitments.map(c => [c.id, c.count])) };
}
