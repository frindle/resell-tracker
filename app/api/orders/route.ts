import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';

export async function GET() {
  const userId = await getSessionUserId();
  const orders = await prisma.order.findMany({
    where: userId ? { userId } : { userId: null },
    include: { buyer: true, card: true },
    orderBy: { orderDate: 'desc' },
  });
  return Response.json(orders);
}

export async function DELETE() {
  const userId = await getSessionUserId();
  const { count } = await prisma.order.deleteMany({
    where: userId ? { userId } : { userId: null },
  });
  return Response.json({ deleted: count });
}

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  const body = await req.json();
  const order = await prisma.order.create({
    data: {
      userId: userId ?? null,
      platform: body.platform,
      orderNumber: body.orderNumber || null,
      orderDate: new Date(body.orderDate),
      itemDescription: body.itemDescription || null,
      cost: parseFloat(body.cost),
      shippingCost: parseFloat(body.shippingCost) || 0,
      salePrice: body.salePrice != null ? parseFloat(body.salePrice) : null,
      buyerId: body.buyerId ? parseInt(body.buyerId) : null,
      cardId: body.cardId ? parseInt(body.cardId) : null,
      cashbackAmount: parseFloat(body.cashbackAmount) || 0,
      shippingAddress: body.shippingAddress || null,
      notes: body.notes || null,
    },
    include: { buyer: true, card: true },
  });
  return Response.json(order, { status: 201 });
}
