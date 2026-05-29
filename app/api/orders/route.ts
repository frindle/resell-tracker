import { prisma } from '@/lib/db';
import { NextRequest } from 'next/server';

export async function GET() {
  const orders = await prisma.order.findMany({
    include: { buyer: true, card: true },
    orderBy: { orderDate: 'desc' },
  });
  return Response.json(orders);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const order = await prisma.order.create({
    data: {
      platform: body.platform,
      orderNumber: body.orderNumber || null,
      orderDate: new Date(body.orderDate),
      itemDescription: body.itemDescription || null,
      cost: parseFloat(body.cost),
      shippingCost: parseFloat(body.shippingCost) || 0,
      salePrice: parseFloat(body.salePrice),
      buyerId: body.buyerId ? parseInt(body.buyerId) : null,
      cardId: body.cardId ? parseInt(body.cardId) : null,
      cashbackAmount: parseFloat(body.cashbackAmount) || 0,
      notes: body.notes || null,
    },
    include: { buyer: true, card: true },
  });
  return Response.json(order, { status: 201 });
}
