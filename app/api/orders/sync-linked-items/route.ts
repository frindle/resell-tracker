import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { syncOrderFromLinks } from '@/lib/linkedItemsSync';

// Backfill for orders linked before linking copied titles and the group onto
// the order. Only orders created in the last `days` days (default 7) that have
// a link, so old orders with hand-kept descriptions are not swept up.
export async function POST(req: Request) {
  const userId = await getSessionUserId();
  if (userId == null) return Response.json({ error: 'not authenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({})) as { days?: number };
  const days = Math.min(90, Math.max(1, Math.floor(Number(body.days) || 7)));
  const since = new Date(Date.now() - days * 86_400_000);
  const orders = await prisma.order.findMany({
    where: {
      userId,
      createdAt: { gte: since },
      OR: [{ bfmrLinks: { some: {} } }, { commitmentLinks: { some: {} } }, { bigSkyLinks: { some: {} } }],
    },
    select: { id: true },
  });
  let titles = 0, buyers = 0;
  for (const o of orders) {
    const r = await syncOrderFromLinks(o.id);
    if (r.itemDescription) titles++;
    if (r.buyerId != null) buyers++;
  }
  return Response.json({ scanned: orders.length, titles, buyers, days });
}
