import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
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
  const userId = await getSessionUserId();
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
      include: { buyer: true, card: { include: { merchantRates: true } }, giftCards: { select: { ccSubmittedAt: true, cardNumber: true } }, commitmentLinks: { select: { id: true } }, bfmrLinks: { select: { id: true, reservation: { select: { status: true } } } } },
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
  const body = await req.json();
  const orderDate = new Date(body.orderDate);
  if (isNaN(orderDate.getTime())) {
    return Response.json({ error: 'Invalid orderDate' }, { status: 400 });
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
