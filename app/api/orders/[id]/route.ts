import { prisma } from '@/lib/db';
import { NextRequest } from 'next/server';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const order = await prisma.order.findUnique({
    where: { id: parseInt(id) },
    include: { buyer: true, card: true },
  });
  if (!order) return Response.json({ error: 'Not found' }, { status: 404 });
  return Response.json(order);
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const order = await prisma.order.update({
    where: { id: parseInt(id) },
    data: {
      platform: body.platform,
      orderNumber: body.orderNumber || null,
      orderDate: new Date(body.orderDate),
      itemDescription: body.itemDescription || null,
      cost: parseFloat(body.cost),
      shippingCost: parseFloat(body.shippingCost) || 0,
      salePrice: body.salePrice != null && body.salePrice !== '' ? parseFloat(body.salePrice) : null,
      buyerId: body.buyerId ? parseInt(body.buyerId) : null,
      cardId: body.cardId ? parseInt(body.cardId) : null,
      cashbackAmount: parseFloat(body.cashbackAmount) || 0,
      notes: body.notes || null,
    },
    include: { buyer: true, card: true },
  });
  return Response.json(order);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await prisma.order.delete({ where: { id: parseInt(id) } });
  return new Response(null, { status: 204 });
}
