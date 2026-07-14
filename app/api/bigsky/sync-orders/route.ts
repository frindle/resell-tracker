import { prisma, getSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { fetchScanItems, fetchNotCheckedInTracking } from '@/lib/bigsky';
import type { BigSkyScanItem } from '@/lib/bigsky';
import { NextRequest } from 'next/server';

function normalize(n: string): string {
  return n.replace(/\D/g, '');
}

interface SyncGroup {
  trackingNumber: string;
  items?: { itemName: string; lineTotal: number }[];
  salePrice: number;
  scanDate: string;
  paymentDate: string | null;
}

function groupScanItems(scanItems: BigSkyScanItem[]): SyncGroup[] {
  const map = new Map<string, SyncGroup>();
  for (const item of scanItems) {
    const key = normalize(item.trackingNumber) || item.trackingNumber;
    if (!map.has(key)) {
      map.set(key, {
        trackingNumber: item.trackingNumber,
        items: [],
        salePrice: 0,
        scanDate: item.scanDate,
        paymentDate: item.paymentDate,
      });
    }
    const g = map.get(key)!;
    const lt = parseFloat(item.lineTotal) || 0;
    g.items!.push({ itemName: item.itemName, lineTotal: lt });
    g.salePrice += lt;
    if (item.paymentDate && (!g.paymentDate || item.paymentDate > g.paymentDate)) g.paymentDate = item.paymentDate;
  }
  return Array.from(map.values());
}

export async function POST(req: NextRequest) {
  try {
  const sessionUid = await getSessionUserId();
  const headerUid = req.headers.get('X-Extension-User-Id');
  const userId = sessionUid ?? (headerUid ? parseInt(headerUid) : null);
  const uid = userId ?? null;

  const body = await req.json() as { groups?: SyncGroup[]; notCheckedInTracking?: string[]; fetch?: boolean };
  let groups: SyncGroup[] = Array.isArray(body.groups) ? body.groups : [];
  let notCheckedInRaw: string[] = Array.isArray(body.notCheckedInTracking) ? body.notCheckedInTracking : [];

  if (body.fetch === true && groups.length === 0) {
    const cookieRow = await getSetting(uid, 'bigsky_cookie');
    const cookie = cookieRow?.value?.trim();
    if (cookie) {
      const scanItems = await fetchScanItems(cookie, uid);
      groups = groupScanItems(scanItems);
      const nci = await fetchNotCheckedInTracking(cookie, uid).catch(() => []);
      notCheckedInRaw = nci.map(r => r.tracking);
    }
  }

  const notCheckedIn = new Set(notCheckedInRaw.map(normalize));

  const bigSkyBuyer = await prisma.buyer.findFirst({
    where: { name: 'BigSkyBuyers' },
  });

  const existing = await prisma.order.findMany({
    where: uid ? { userId: uid } : { userId: null },
    select: { id: true, trackingNumbers: true, itemDescription: true, salePrice: true, salePriceSynced: true, overdueAt: true, buyerId: true, trackingSubmittedToBg: true, bgCredited: true, bgExpectedPayout: true, bgPaidAmount: true },
  });

  // Build lookup: normalized tracking number → orders (one tracking can span multiple orders)
  const byTracking = new Map<string, (typeof existing[0])[]>();
  for (const o of existing) {
    if (!o.trackingNumbers) continue;
    for (const t of o.trackingNumbers.split(',').map(s => s.trim()).filter(Boolean)) {
      const norm = normalize(t);
      if (!byTracking.has(norm)) byTracking.set(norm, []);
      byTracking.get(norm)!.push(o);
    }
  }

  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  let updated = 0;

  for (const group of groups) {
    const normTracking = normalize(group.trackingNumber);
    const isPaid = group.paymentDate != null;
    const matches = byTracking.get(normTracking);

    if (!matches || matches.length === 0) continue;

    // When one tracking number maps to multiple orders, split value by
    // matching BigSky itemName to order itemDescription.
    const valueByOrderId = new Map<number, number>();
    if (matches.length > 1 && group.items && group.items.length > 0) {
      const unmatched: { lineTotal: number }[] = [];
      for (const item of group.items) {
        const nameNorm = (item.itemName ?? '').toLowerCase().trim();
        const hit = matches.find(o =>
          o.itemDescription && nameNorm && o.itemDescription.toLowerCase().trim().includes(nameNorm)
        ) ?? matches.find(o =>
          o.itemDescription && nameNorm && nameNorm.includes(o.itemDescription.toLowerCase().trim())
        );
        if (hit) {
          valueByOrderId.set(hit.id, (valueByOrderId.get(hit.id) ?? 0) + item.lineTotal);
        } else {
          unmatched.push(item);
        }
      }
      // Spread unmatched items evenly across orders that got nothing
      if (unmatched.length > 0) {
        const unmatchedTotal = unmatched.reduce((s, i) => s + i.lineTotal, 0);
        const emptyOrders = matches.filter(o => !valueByOrderId.has(o.id));
        const targets = emptyOrders.length > 0 ? emptyOrders : matches;
        const perOrder = unmatchedTotal / targets.length;
        for (const o of targets) {
          valueByOrderId.set(o.id, (valueByOrderId.get(o.id) ?? 0) + perOrder);
        }
      }
    } else if (matches.length === 1) {
      valueByOrderId.set(matches[0].id, group.salePrice);
    } else {
      // Multiple orders, no item breakdown — split evenly
      const perOrder = group.salePrice / matches.length;
      for (const m of matches) valueByOrderId.set(m.id, perOrder);
    }

    for (const match of matches) {
      const orderValue = valueByOrderId.get(match.id) ?? group.salePrice;
      const patch: Record<string, unknown> = {};

      // Track expected payout from scan data — update whenever the value changes
      if (match.bgExpectedPayout == null || Math.abs((match.bgExpectedPayout ?? 0) - orderValue) > 0.01) {
        patch.bgExpectedPayout = orderValue;
      }

      if (isPaid) {
        if (match.salePrice == null || !match.salePriceSynced) {
          patch.salePrice = orderValue;
          patch.salePriceSynced = true;
        }
        if (match.bgPaidAmount == null || Math.abs((match.bgPaidAmount ?? 0) - orderValue) > 0.01) {
          patch.bgPaidAmount = orderValue;
        }
        if (match.overdueAt) patch.overdueAt = null;
      } else if (!isPaid && !match.salePriceSynced) {
        // Pre-fill salePrice from scan so the user sees the expected value before payment
        if (match.salePrice == null) patch.salePrice = orderValue;
      }

      const scanDate = group.scanDate ? new Date(group.scanDate) : null;
      if (!isPaid && scanDate && scanDate < cutoff && !match.overdueAt) {
        patch.overdueAt = new Date();
      }

      if (group.scanDate && !match.bgCredited) patch.bgCredited = true;
      if (match.buyerId == null && bigSkyBuyer) patch.buyerId = bigSkyBuyer.id;

      if (Object.keys(patch).length > 0) {
        const result = await prisma.order.updateMany({ where: { id: match.id, locked: false }, data: patch });
        if (result.count) updated++;
      }
    }
  }

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

  // Flag BigSky-buyer orders whose tracking isn't in BigSky's system at all
  // (not scanned, not in not-checked-in queue = never submitted or submission lost)
  let missing = 0;
  if (bigSkyBuyer && (groups.length > 0 || notCheckedIn.size > 0)) {
    const knownByBigSky = new Set<string>();
    for (const g of groups) knownByBigSky.add(normalize(g.trackingNumber));
    for (const n of notCheckedIn) knownByBigSky.add(n);

    const bsOrders = existing.filter(o =>
      o.buyerId === bigSkyBuyer.id &&
      o.trackingNumbers &&
      !o.salePriceSynced &&
      o.trackingSubmittedToBg
    );
    for (const o of bsOrders) {
      const nums = o.trackingNumbers!.split(',').map(s => normalize(s.trim())).filter(Boolean);
      const allMissing = nums.length > 0 && nums.every(n => !knownByBigSky.has(n));
      if (allMissing) {
        // Clear the flag so auto-submit retries
        await prisma.order.updateMany({
          where: { id: o.id, locked: false },
          data: { trackingSubmittedToBg: false },
        });
        missing++;
      }
    }
  }

  return Response.json({ updated, confirmed, missing, total: groups.length });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
