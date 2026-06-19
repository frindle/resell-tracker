import { prisma } from '@/lib/db';
import { NextRequest } from 'next/server';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
  const { id } = await params;
  const orders = await prisma.order.findMany({
    where: { buyerId: parseInt(id), salePrice: { not: null } },
    orderBy: { orderDate: 'desc' },
    select: {
      id: true,
      orderDate: true,
      platform: true,
      orderNumber: true,
      itemDescription: true,
      cost: true,
      salePrice: true,
    },
  });
  return Response.json(orders);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
