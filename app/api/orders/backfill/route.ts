import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';

// Returns Amazon orders missing shippingAddress or itemDescription
export async function GET(req: NextRequest) {
  try {
  const resolvedUserId = await getSessionUserId();

  const orders = await prisma.order.findMany({
    where: {
      userId: resolvedUserId ?? null,
      platform: 'Amazon',
      orderNumber: { not: null },
      OR: [
        { shippingAddress: null },
        { shippingAddress: '' },
        { itemDescription: null },
        { itemDescription: '' },
      ],
    },
    select: { id: true, orderNumber: true, shippingAddress: true, itemDescription: true },
  });

  return Response.json(orders, {
    headers: { 'Access-Control-Allow-Origin': '*' },
  });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Extension-User-Id',
    },
  });
}
