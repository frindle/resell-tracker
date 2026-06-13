import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';

function normalize(n: string): string {
  return n.replace(/\D/g, '');
}

interface SyncGroup {
  trackingNumber: string;
  itemDescription: string;
  salePrice: number;
  scanDate: string;
  paymentDate: string | null;
}

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  const uid = userId ?? null;

  const body = await req.json() as { groups: SyncGroup[] };
  const groups: SyncGroup[] = Array.isArray(body.groups) ? body.groups : [];

  const bigSkyBuyer = await prisma.buyer.findFirst({
    where: { name: 'BigSkyBuyers' },
  });

  const existing = await prisma.order.findMany({
    where: uid ? { userId: uid } : { userId: null },
    select: { id: true, trackingNumbers: true, salePrice: true, salePriceSynced: true, overdueAt: true, buyerId: true },
  });

  // Build lookup: normalized tracking number → order
  const byTracking = new Map<string, typeof existing[0]>();
  for (const o of existing) {
    if (!o.trackingNumbers) continue;
    for (const t of o.trackingNumbers.split(',').map(s => s.trim()).filter(Boolean)) {
      byTracking.set(normalize(t), o);
    }
  }

  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  let updated = 0;

  for (const group of groups) {
    const normTracking = normalize(group.trackingNumber);
    const isPaid = group.paymentDate != null;
    const match = byTracking.get(normTracking);

    if (!match) continue;

    const patch: Record<string, unknown> = {};

    if (isPaid && (match.salePrice == null || !match.salePriceSynced)) {
      patch.salePrice = group.salePrice;
      patch.salePriceSynced = true;
    }
    if (isPaid && match.overdueAt) patch.overdueAt = null;

    const scanDate = group.scanDate ? new Date(group.scanDate) : null;
    if (!isPaid && scanDate && scanDate < cutoff && !match.overdueAt) {
      patch.overdueAt = new Date();
    }

    if (match.buyerId == null && bigSkyBuyer) patch.buyerId = bigSkyBuyer.id;

    if (Object.keys(patch).length > 0) {
      const result = await prisma.order.updateMany({ where: { id: match.id, locked: false }, data: patch });
      if (result.count) updated++;
    }
  }

  return Response.json({ updated, total: groups.length });
}
