import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { fulfillmentsForOrder, ordersForTracking, plannedUnits, storedFulfillments } from '@/lib/bigskyCommitments';
import { recalcBigSkySalePrice } from '@/lib/bigskySalePriceRecalc';
import { NextRequest } from 'next/server';
import { syncOrderFromLinks } from '@/lib/linkedItemsSync';

export const dynamic = 'force-dynamic';

const DAY_MS = 86_400_000;

// One order's BigSky picture: commitments its scanned boxes filled (from
// BigSky), commitments the user set it aside for (links), and the open
// commitments it could be set aside for.
export async function GET(req: NextRequest) {
  const uid = await getSessionUserId();
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });
  const orderId = parseInt(req.nextUrl.searchParams.get('orderId') ?? '', 10);
  if (!Number.isFinite(orderId)) return Response.json({ error: 'orderId required' }, { status: 400 });

  const order = await prisma.order.findFirst({ where: { id: orderId, userId: uid }, select: { id: true, trackingNumbers: true } });
  if (!order) return Response.json({ error: 'order not found' }, { status: 404 });

  const rows = await prisma.bigSkyCommitment.findMany({
    where: { userId: uid },
    orderBy: [{ dealExpiration: 'asc' }, { id: 'asc' }],
    include: { orderLinks: { select: { id: true, orderId: true, quantity: true } } },
  });
  const commitments = rows.map(r => ({ ...r, fulfillments: storedFulfillments(r.fulfillments) }));

  // Which orders each commitment's scans already filled, so a planned link
  // stops counting once its box is scanned.
  const linkedOrderIds = [...new Set(rows.flatMap(r => r.orderLinks.map(l => l.orderId)))];
  const linkedOrders = linkedOrderIds.length === 0 ? [] : await prisma.order.findMany({
    where: { id: { in: linkedOrderIds }, userId: uid },
    select: { id: true, trackingNumbers: true, cancelled: true },
  });
  // A cancelled order's set-aside no longer covers anything.
  const cancelledIds = new Set(linkedOrders.filter(o => o.cancelled).map(o => o.id));
  const filledIds = (c: (typeof commitments)[number]) =>
    new Set(c.fulfillments.flatMap(f => ordersForTracking(linkedOrders, f.trackingNumbers).map(o => o.id)));

  const now = Date.now();
  const summary = (c: (typeof commitments)[number]) => {
    const planned = plannedUnits(c.orderLinks.filter(l => !cancelledIds.has(l.orderId)), filledIds(c));
    const open = Math.max(0, c.commitmentAmount - c.fulfilled);
    return {
      id: c.id,
      commitmentId: c.commitmentId,
      itemName: c.itemName,
      itemUpc: c.itemUpc,
      dealPrice: c.dealPrice,
      commitmentAmount: c.commitmentAmount,
      fulfilled: c.fulfilled,
      open,
      planned,
      unplanned: Math.max(0, open - planned),
      status: c.status,
      dealExpiration: c.dealExpiration?.toISOString() ?? null,
      expired: c.dealExpiration != null && c.dealExpiration.getTime() + DAY_MS <= now,
    };
  };

  const filled = fulfillmentsForOrder(commitments, order.trackingNumbers).map(({ commitment, fulfillment }) => ({
    commitment: summary(commitment),
    quantity: fulfillment.quantity,
    date: fulfillment.date,
  }));
  const filledHere = new Set(filled.map(f => f.commitment.id));

  const links = commitments.flatMap(c => c.orderLinks
    .filter(l => l.orderId === orderId)
    .map(l => ({ id: l.id, quantity: l.quantity, scanned: filledHere.has(c.id), commitment: summary(c) })));
  const linkedHere = new Set(links.map(l => l.commitment.id));

  const available = commitments
    .filter(c => !linkedHere.has(c.id) && !filledHere.has(c.id))
    .map(summary)
    // Only commitments with units nobody has set an order aside for yet.
    .filter(s => s.unplanned > 0 && !s.expired);

  return Response.json({ filled, links, available });
}

// Set an order aside for a commitment (or change the quantity). The order's
// salePrice and expected payout follow the links (lib/bigskySalePrice.ts).
export async function POST(req: NextRequest) {
  const uid = await getSessionUserId();
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({})) as { orderId?: unknown; commitmentId?: unknown; quantity?: unknown };
  const orderId = Number(body.orderId), commitmentId = Number(body.commitmentId);
  const quantity = Math.floor(Number(body.quantity ?? 1));
  if (!Number.isInteger(orderId) || !Number.isInteger(commitmentId) || !Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
    return Response.json({ error: 'orderId, commitmentId and a quantity of 1-999 are required' }, { status: 400 });
  }
  const [order, commitment] = await Promise.all([
    prisma.order.findFirst({ where: { id: orderId, userId: uid }, select: { id: true } }),
    prisma.bigSkyCommitment.findFirst({ where: { id: commitmentId, userId: uid }, select: { id: true } }),
  ]);
  if (!order || !commitment) return Response.json({ error: 'order or commitment not found' }, { status: 404 });

  const link = await prisma.orderBigSkyLink.upsert({
    where: { orderId_commitmentId: { orderId, commitmentId } },
    create: { orderId, commitmentId, quantity },
    update: { quantity },
  });
  const price = await recalcBigSkySalePrice(orderId);
  await syncOrderFromLinks(orderId);
  return Response.json({ id: link.id, quantity: link.quantity, salePrice: price.salePrice, salePriceKept: price.skipped ?? null });
}
