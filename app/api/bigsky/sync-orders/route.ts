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
  try {
  const userId = await getSessionUserId();
  const uid = userId ?? null;

  const body = await req.json() as { groups: SyncGroup[]; notCheckedInTracking?: string[] };
  const groups: SyncGroup[] = Array.isArray(body.groups) ? body.groups : [];
  // Tracking numbers BigSky confirms it has received (submitted, awaiting
  // scan) — from tracking.getNotCheckedInTracking. A hit here is stronger
  // evidence than the locally-set trackingSubmittedToBg flag, which only
  // means "we believe we sent the submit-tracking request", not that BigSky
  // actually recorded it.
  const notCheckedIn = new Set(
    (Array.isArray(body.notCheckedInTracking) ? body.notCheckedInTracking : []).map(normalize)
  );

  const bigSkyBuyer = await prisma.buyer.findFirst({
    where: { name: 'BigSkyBuyers' },
  });

  const existing = await prisma.order.findMany({
    where: uid ? { userId: uid } : { userId: null },
    select: { id: true, trackingNumbers: true, salePrice: true, salePriceSynced: true, overdueAt: true, buyerId: true, trackingSubmittedToBg: true },
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

  // Confirm submission for orders whose tracking BigSky reports as
  // "received, not yet scanned" — closes the gap where trackingSubmittedToBg
  // was set locally on submit but never actually verified against BigSky.
  let confirmed = 0;
  for (const o of existing) {
    if (o.trackingSubmittedToBg || !o.trackingNumbers) continue;
    const nums = o.trackingNumbers.split(',').map(s => normalize(s.trim())).filter(Boolean);
    if (!nums.some(n => notCheckedIn.has(n))) continue;
    const result = await prisma.order.updateMany({
      where: { id: o.id, locked: false },
      data: { trackingSubmittedToBg: true },
    });
    if (result.count) confirmed++;
  }

  return Response.json({ updated, confirmed, total: groups.length });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
