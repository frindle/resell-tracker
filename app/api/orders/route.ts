import { prisma } from '@/lib/db';
import { scheduleBooksReconcile } from '@/lib/books/service';
import { getSessionUserId } from '@/lib/auth';
import { resolveExtensionUserId } from '@/lib/extensionAuth';
import { NextRequest } from 'next/server';

function parseAmount(v: unknown): number {
  return parseFloat(String(v ?? '').replace(/,/g, '')) || 0;
}
function parseAmountNullable(v: unknown): number | null {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

// Optional query params:
//   ?limit=N        default 1000, max 5000 — caps how many orders come back.
//   ?offset=N       default 0 — for basic page-through.
//   ?since=<ISO>    filter to orders created on/after this date.
//   ?all=1          bypass the default limit (returns everything). Existing
//                   /orders page can opt-in explicitly if it needs it.
// Response is an array as before. X-Total-Count header carries the full
// matching count so a client can know it hit the cap.
export async function GET(req: NextRequest) {
  try {
  const sessionUid = await getSessionUserId();
  const userId = resolveExtensionUserId(req, sessionUid);
  const url = new URL(req.url);
  const wantAll = url.searchParams.get('all') === '1';
  const rawLimit = parseInt(url.searchParams.get('limit') ?? '') || 1000;
  const limit = wantAll ? undefined : Math.min(Math.max(rawLimit, 1), 5000);
  const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '') || 0, 0);
  const sinceRaw = url.searchParams.get('since');
  const since = sinceRaw ? new Date(sinceRaw) : null;

  const where = {
    ...(userId ? { userId } : { userId: null }),
    ignoredByRule: false,
    ...(since && !isNaN(since.getTime()) ? { createdAt: { gte: since } } : {}),
  };

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      include: { buyer: true, card: { include: { merchantRates: true } }, giftCards: { select: { ccSubmittedAt: true, ccGiftCardId: true, cardNumber: true } }, commitmentLinks: { select: { id: true, quantity: true } }, bfmrLinks: { select: { id: true, quantity: true, trackingNumber: true, reservation: { select: { status: true, qty: true, trackingNumber: true, submittedShipments: { select: { trackingNumber: true, qty: true } } } } } }, returns: { select: { status: true, quantity: true } }, _count: { select: { attachments: true } } },
      orderBy: { createdAt: 'desc' },
      ...(limit != null ? { take: limit } : {}),
      ...(offset > 0 ? { skip: offset } : {}),
    }),
    prisma.order.count({ where }),
  ]);

  return new Response(JSON.stringify(orders), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'X-Total-Count': String(total),
    },
  });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function DELETE() {
  try {
  const userId = await getSessionUserId();
  scheduleBooksReconcile(userId);
  const { count } = await prisma.order.deleteMany({
    where: userId ? { userId } : { userId: null },
  });
  return Response.json({ deleted: count });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
  const userId = await getSessionUserId();
  scheduleBooksReconcile(userId);
  const body = await req.json();
  const orderDate = new Date(body.orderDate);
  if (isNaN(orderDate.getTime())) {
    return Response.json({ error: 'Invalid orderDate' }, { status: 400 });
  }
  // An order drafted from a photo: if another photo of the same purchase
  // already made it (same order number, or same store, day and cost), hand
  // back that order instead of creating a second one.
  if (body.fromPhoto === true) {
    const same = await findSameOrder(userId, body.platform, body.orderNumber || null, orderDate, parseAmount(body.cost));
    if (same) return Response.json({ ...same, existing: true }, { status: 200 });
  }
  const order = await prisma.order.create({
    data: {
      userId: userId ?? null,
      platform: body.platform,
      orderNumber: body.orderNumber || null,
      orderDate,
      itemDescription: body.itemDescription || null,
      cost: parseAmount(body.cost),
      shippingCost: parseAmount(body.shippingCost),
      insuranceCost: parseAmount(body.insuranceCost),
      salePrice: parseAmountNullable(body.salePrice),
      salePriceSynced: false,
      buyerId: body.buyerId ? parseInt(body.buyerId) : null,
      cardId: body.cardId ? parseInt(body.cardId) : null,
      cashbackAmount: parseAmount(body.cashbackAmount),
      portalCashback: parseAmountNullable(body.portalCashback),
      amexOfferDollars: parseAmountNullable(body.amexOfferDollars),
      amexOfferPoints: parseAmountNullable(body.amexOfferPoints),
      shippingAddress: body.shippingAddress || null,
      notes: body.notes || null,
      overdueAt: body.overdueAt ? new Date(body.overdueAt) : null,
      deliveryDeadline: body.deliveryDeadline ? new Date(body.deliveryDeadline) : null,
    },
    include: { buyer: true, card: { include: { merchantRates: true } } },
  });
  return Response.json(order, { status: 201 });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

/** The user's order that is the same purchase as a photo draft, if any. */
async function findSameOrder(userId: number | null, platform: string, orderNumber: string | null, orderDate: Date, cost: number) {
  const norm = (s: string | null | undefined) => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (orderNumber && norm(orderNumber).length >= 4) {
    const byNumber = await prisma.order.findMany({ where: { userId, orderNumber: { not: null } }, select: { id: true, platform: true, orderNumber: true, orderDate: true, itemDescription: true } });
    const hit = byNumber.find(o => norm(o.orderNumber) === norm(orderNumber));
    if (hit) return hit;
  }
  const day = orderDate.toISOString().slice(0, 10);
  const from = new Date(`${day}T00:00:00.000Z`);
  const near = await prisma.order.findMany({
    where: { userId, orderDate: { gte: new Date(from.getTime() - 86_400_000), lt: new Date(from.getTime() + 2 * 86_400_000) } },
    select: { id: true, platform: true, orderNumber: true, orderDate: true, itemDescription: true, cost: true },
  });
  const hit = near.find(o => norm(o.platform) === norm(platform) && o.orderDate.toISOString().slice(0, 10) === day && Math.abs(o.cost - cost) < 0.01);
  if (!hit) return null;
  const { cost: _c, ...rest } = hit;
  void _c;
  return rest;
}
