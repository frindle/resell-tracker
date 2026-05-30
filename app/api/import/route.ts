import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';

type ImportRow = {
  platform: string;
  orderNumber: string;
  orderDate: string;
  itemDescription: string;
  cost: number;
  shippingCost: number;
  salePrice: number | null;
  buyerId: string;
  cardId: string;
  cashbackAmount: number;
};

function normalize(n: string | null | undefined): string {
  return (n ?? '').replace(/\D/g, '');
}

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  const rows: ImportRow[] = await req.json();

  // Deduplicate: fetch all existing order numbers and normalize for comparison
  const allExisting = await prisma.order.findMany({ select: { orderNumber: true } });
  const existingNorms = new Set(allExisting.map(o => normalize(o.orderNumber)));

  const seenInBatch = new Set<string>();
  const toCreate: ImportRow[] = [];
  let skipped = 0;

  for (const r of rows) {
    const norm = normalize(r.orderNumber);
    // Orders without a number always pass through
    if (!norm) {
      toCreate.push(r);
      continue;
    }
    if (existingNorms.has(norm) || seenInBatch.has(norm)) {
      skipped++;
      continue;
    }
    seenInBatch.add(norm);
    toCreate.push(r);
  }

  const created = await Promise.all(
    toCreate.map(r =>
      prisma.order.create({
        data: {
          userId: userId ?? null,
          platform: r.platform,
          orderNumber: r.orderNumber || null,
          orderDate: new Date(r.orderDate),
          itemDescription: r.itemDescription || null,
          cost: r.cost,
          shippingCost: r.shippingCost,
          salePrice: r.salePrice || null,
          buyerId: r.buyerId ? parseInt(r.buyerId) : null,
          cardId: r.cardId ? parseInt(r.cardId) : null,
          cashbackAmount: r.cashbackAmount,
        },
      })
    )
  );

  return Response.json({ imported: created.length, skipped }, { status: 201 });
}
