import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { bigSkyLinkTotalFor, recalcBigSkySalePrice } from '@/lib/bigskySalePriceRecalc';
import { syncOrderFromLinks } from '@/lib/linkedItemsSync';

export const dynamic = 'force-dynamic';

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const uid = await getSessionUserId();
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });
  const id = parseInt((await params).id, 10);
  if (!Number.isFinite(id)) return Response.json({ error: 'bad id' }, { status: 400 });
  const link = await prisma.orderBigSkyLink.findFirst({ where: { id, order: { userId: uid } }, select: { orderId: true, commitmentId: true } });
  if (!link) return Response.json({ error: 'link not found' }, { status: 404 });
  const previousTotal = await bigSkyLinkTotalFor(link.orderId);
  const { count } = await prisma.orderBigSkyLink.deleteMany({ where: { id, order: { userId: uid } } });
  if (count === 0) return Response.json({ error: 'link not found' }, { status: 404 });
  // Removed on purpose: automatic matching must not link this commitment again.
  await prisma.bigSkyCommitment.update({ where: { id: link.commitmentId }, data: { autoLinkDismissedAt: new Date() } });
  const price = await recalcBigSkySalePrice(link.orderId, { previousTotal });
  await syncOrderFromLinks(link.orderId);
  return Response.json({ deleted: true, salePrice: price.salePrice, salePriceKept: price.skipped ?? null });
}
