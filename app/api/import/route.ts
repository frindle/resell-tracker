import { prisma } from '@/lib/db';
import { NextRequest } from 'next/server';

type ImportRow = {
  platform: string;
  orderNumber: string;
  orderDate: string;
  itemDescription: string;
  cost: number;
  shippingCost: number;
  salePrice: number;
  buyerId: string;
  cardId: string;
  cashbackAmount: number;
};

export async function POST(req: NextRequest) {
  const rows: ImportRow[] = await req.json();

  const created = await Promise.all(
    rows.map(r =>
      prisma.order.create({
        data: {
          platform: r.platform,
          orderNumber: r.orderNumber || null,
          orderDate: new Date(r.orderDate),
          itemDescription: r.itemDescription || null,
          cost: r.cost,
          shippingCost: r.shippingCost,
          salePrice: r.salePrice,
          buyerId: r.buyerId ? parseInt(r.buyerId) : null,
          cardId: r.cardId ? parseInt(r.cardId) : null,
          cashbackAmount: r.cashbackAmount,
        },
      })
    )
  );

  return Response.json({ imported: created.length }, { status: 201 });
}
