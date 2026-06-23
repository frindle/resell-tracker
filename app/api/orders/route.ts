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

export async function GET() {
  try {
  const userId = await getSessionUserId();
  const orders = await prisma.order.findMany({
    where: userId ? { userId, ignoredByRule: false } : { userId: null, ignoredByRule: false },
    include: { buyer: true, card: { include: { merchantRates: true } }, giftCards: { select: { ccSubmittedAt: true } }, commitmentLinks: { select: { id: true } }, bfmrLinks: { select: { id: true } } },
    orderBy: { createdAt: 'desc' },
  });
  return Response.json(orders);
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
      shippingAddress: body.shippingAddress || null,
      notes: body.notes || null,
      overdueAt: body.overdueAt ? new Date(body.overdueAt) : null,
    },
    include: { buyer: true, card: { include: { merchantRates: true } } },
  });
  return Response.json(order, { status: 201 });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
