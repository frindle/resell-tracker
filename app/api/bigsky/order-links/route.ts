import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { fulfillmentsForOrder, ordersForTracking, plannedUnits, storedFulfillments } from '@/lib/bigskyCommitments';
import { bigSkyLinkTotalFor, recalcBigSkySalePrice } from '@/lib/bigskySalePriceRecalc';
import { exceedsCapacity, offerableCommitments, planLinkChange, unitsFreeForOrder } from '@/lib/bigskyOrderLinks';
import { withKeyedLock } from '@/lib/keyedLock';
import { NextRequest } from 'next/server';
import { syncOrderFromLinks } from '@/lib/linkedItemsSync';

export const dynamic = 'force-dynamic';

const DAY_MS = 86_400_000;

type CommitmentRow = {
  fulfillments: string | null;
  orderLinks: { id: number; orderId: number; quantity: number }[];
};

// Which linked orders are cancelled (their set-aside covers nothing) and which
// orders each commitment's scans already filled (their set-aside stops
// counting). Shared by the GET and the POST capacity check so "offered" and
// "accepted" use the same numbers.
async function planningContext<R extends CommitmentRow>(uid: number, rows: R[]) {
  const commitments = rows.map(r => ({ ...r, fulfillments: storedFulfillments(r.fulfillments) }));
  const linkedOrderIds = [...new Set(rows.flatMap(r => r.orderLinks.map(l => l.orderId)))];
  const linkedOrders = linkedOrderIds.length === 0 ? [] : await prisma.order.findMany({
    where: { id: { in: linkedOrderIds }, userId: uid },
    select: { id: true, trackingNumbers: true, cancelled: true },
  });
  const cancelledIds = new Set(linkedOrders.filter(o => o.cancelled).map(o => o.id));
  const filledIds = (c: (typeof commitments)[number]) =>
    new Set(c.fulfillments.flatMap(f => ordersForTracking(linkedOrders, f.trackingNumbers).map(o => o.id)));
  // Units other live orders hold on this commitment, never this order's own link.
  const othersPlanned = (c: (typeof commitments)[number], orderId: number) =>
    plannedUnits(c.orderLinks.filter(l => l.orderId !== orderId && !cancelledIds.has(l.orderId)), filledIds(c));
  return { commitments, linkedOrders, cancelledIds, filledIds, othersPlanned };
}

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
  const { commitments, cancelledIds, filledIds, othersPlanned } = await planningContext(uid, rows);

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

  // Units other live orders have not set aside. This order's own link is not
  // counted against a commitment, so one that is full only because of it is still offered.
  const ownQuantity = new Map(links.map(l => [l.commitment.id, l.quantity] as const));
  const others = new Map(commitments.map(c => [c.id, othersPlanned(c, orderId)] as const));
  const available = offerableCommitments(commitments.map(summary), others, ownQuantity, filledHere)
    .map(({ free, linkedQuantity, ...s }) => ({ ...s, unplanned: free, linkedQuantity }));

  return Response.json({ filled, links, available });
}

// Set an order aside for a commitment (or change the quantity). The order's
// salePrice and expected payout follow the links (lib/bigskySalePrice.ts).
export async function POST(req: NextRequest) {
  const uid = await getSessionUserId();
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({})) as { orderId?: unknown; commitmentId?: unknown; quantity?: unknown; replaceLinkId?: unknown };
  const orderId = Number(body.orderId), commitmentId = Number(body.commitmentId);
  const quantity = Math.floor(Number(body.quantity ?? 1));
  if (!Number.isInteger(orderId) || !Number.isInteger(commitmentId) || !Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
    return Response.json({ error: 'orderId, commitmentId and a quantity of 1-999 are required' }, { status: 400 });
  }
  // Read, capacity check and write run one at a time per commitment, so two
  // requests cannot both take its last unit.
  return withKeyedLock(`bigsky-commitment:${commitmentId}`, async () => {
  const [order, commitment] = await Promise.all([
    prisma.order.findFirst({ where: { id: orderId, userId: uid }, select: { id: true } }),
    prisma.bigSkyCommitment.findFirst({
      where: { id: commitmentId, userId: uid },
      include: { orderLinks: { select: { id: true, orderId: true, quantity: true } } },
    }),
  ]);
  if (!order || !commitment) return Response.json({ error: 'order or commitment not found' }, { status: 404 });

  // The same room the GET offers: units other live orders have not set aside.
  const ctx = await planningContext(uid, [commitment]);
  const target = ctx.commitments[0];
  const free = unitsFreeForOrder({
    open: Math.max(0, target.commitmentAmount - target.fulfilled),
    othersPlanned: ctx.othersPlanned(target, orderId),
  });
  const own = target.orderLinks.find(l => l.orderId === orderId);
  if (exceedsCapacity(quantity, free, own ? own.quantity : null)) {
    return Response.json({ error: `only ${free} unit${free === 1 ? '' : 's'} free on that commitment` }, { status: 409 });
  }

  // "Change": swap an existing link for this commitment in one step.
  const replaceRaw = body.replaceLinkId == null ? null : Number(body.replaceLinkId);
  if (replaceRaw != null && !Number.isInteger(replaceRaw)) {
    return Response.json({ error: 'replaceLinkId must be a whole number' }, { status: 400 });
  }
  const ownLinks = await prisma.orderBigSkyLink.findMany({ where: { orderId }, select: { id: true, commitmentId: true } });
  const plan = planLinkChange(ownLinks, commitmentId, replaceRaw);
  if (!plan.ok) return Response.json({ error: plan.error }, { status: 400 });

  const previousTotal = await bigSkyLinkTotalFor(orderId);
  const upsert = prisma.orderBigSkyLink.upsert({
    where: { orderId_commitmentId: { orderId, commitmentId } },
    create: { orderId, commitmentId, quantity },
    update: { quantity },
  });
  const old = ownLinks.find(l => l.id === plan.deleteLinkId);
  const link = old
    ? (await prisma.$transaction([
      upsert,
      prisma.orderBigSkyLink.deleteMany({ where: { id: old.id, orderId } }),
      // Removed on purpose: automatic matching must not link it again.
      prisma.bigSkyCommitment.update({ where: { id: old.commitmentId }, data: { autoLinkDismissedAt: new Date() } }),
    ]))[0]
    : await upsert;
  const price = await recalcBigSkySalePrice(orderId, { previousTotal });
  await syncOrderFromLinks(orderId);
  return Response.json({ id: link.id, quantity: link.quantity, salePrice: price.salePrice, salePriceKept: price.skipped ?? null });
  });
}
