import { prisma } from '@/lib/db';
import { NextRequest } from 'next/server';

export async function GET() {
  try {
  const buyers = await prisma.buyer.findMany({
    orderBy: { name: 'asc' },
    include: {
      _count: { select: { orders: true } },
      orders: {
        select: { salePrice: true, orderDate: true },
        where: { salePrice: { not: null } },
      },
      shippingRules: { select: { id: true, label: true, pattern: true } },
    },
  });

  return Response.json(buyers.map(b => ({
    id: b.id,
    name: b.name,
    createdAt: b.createdAt,
    orderCount: b._count.orders,
    totalPaid: b.orders.reduce((sum, o) => sum + (o.salePrice ?? 0), 0),
    lastOrderDate: b.orders.length
      ? b.orders.reduce((latest, o) =>
          o.orderDate > latest ? o.orderDate : latest,
          b.orders[0].orderDate,
        )
      : null,
    addresses: b.shippingRules.map(r => ({ id: r.id, label: r.label, pattern: r.pattern })),
  })));
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
  const body = await req.json();
  const buyer = await prisma.buyer.create({ data: { name: body.name } });
  return Response.json(buyer, { status: 201 });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
