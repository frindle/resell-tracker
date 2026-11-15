import { prisma } from '@/lib/db';
import { bigSkyLinkTotal, decideBigSkySalePrice, type BigSkyLinkRow } from '@/lib/bigskySalePrice';

async function linkRows(orderId: number): Promise<BigSkyLinkRow[]> {
  const links = await prisma.orderBigSkyLink.findMany({
    where: { orderId },
    select: { quantity: true, commitment: { select: { dealPrice: true } } },
  });
  return links.map(l => ({ dealPrice: l.commitment.dealPrice, quantity: l.quantity }));
}

/** The order's BigSky link total now (read before an unlink, for recalcBigSkySalePrice's previousTotal). */
export async function bigSkyLinkTotalFor(orderId: number): Promise<number> {
  return bigSkyLinkTotal(await linkRows(orderId));
}

/**
 * Reprice an order from its BigSky links (rules in lib/bigskySalePrice.ts).
 * Returns the order's salePrice afterwards and, when nothing was written, why.
 */
export async function recalcBigSkySalePrice(
  orderId: number,
  opts: { previousTotal?: number | null; respectLock?: boolean } = {},
): Promise<{ salePrice: number | null; skipped?: string }> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { salePrice: true, bgExpectedPayout: true, salePriceSynced: true, cancelled: true, locked: true, bgCredited: true },
  });
  if (!order) return { salePrice: null, skipped: 'missing' };
  const d = decideBigSkySalePrice(order, await linkRows(orderId), opts);
  if (d.action === 'skip') {
    if (d.reason !== 'unchanged') console.log(`[bigsky-recalc] order ${orderId}: kept $${order.salePrice ?? '—'} (${d.reason})`);
    return { salePrice: order.salePrice, skipped: d.reason };
  }
  const { count } = await prisma.order.updateMany({
    where: opts.respectLock ? { id: orderId, locked: false } : { id: orderId },
    data: { salePrice: d.salePrice, bgExpectedPayout: d.bgExpectedPayout },
  });
  if (count === 0) return { salePrice: order.salePrice, skipped: 'locked' };
  console.log(`[bigsky-recalc] order ${orderId}: salePrice $${order.salePrice ?? '—'} → $${d.salePrice ?? '—'}, bgExpectedPayout → $${d.bgExpectedPayout ?? '—'}`);
  return { salePrice: d.salePrice };
}
