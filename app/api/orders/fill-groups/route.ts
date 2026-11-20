import { NextRequest } from 'next/server';
import { getSessionUserId } from '@/lib/auth';
import { fillGroups } from '@/lib/groupFillRun';
import { queueGapFill } from '@/lib/emailAutoImport';
import type { GapOrder } from '@/lib/gapFill';

// Backfill for orders with no group. Dry run by default: ?apply=1 acts.
// ?days=N sets how far back to look (default 30).
//
// 1. Shipping rules on the stored address, then the item against the group
//    deals (lib/groupFill.ts). Sets only an empty group, on cancelled and
//    locked orders too.
// 2. What is still empty queues the retailer's per-order page read, which
//    brings the real ship-to address (Walmart, Costco, Amazon).
// Returns counts only.
export async function POST(req: NextRequest) {
  try {
    const userId = await getSessionUserId();
    const url = new URL(req.url);
    const apply = url.searchParams.get('apply') === '1';
    const rawDays = parseInt(url.searchParams.get('days') ?? '', 10);
    const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(rawDays, 365) : 30;

    const result = await fillGroups(userId ?? null, { days }, apply);
    const left = result.left.filter(o => o.orderNumber);
    const fillable = new Set(['Walmart', 'Costco', 'Amazon']);
    const toRead: GapOrder[] = left.filter(o => fillable.has(o.platform)).map(o => ({
      platform: o.platform, orderNumber: String(o.orderNumber), itemDescription: 'x', shippingAddress: 'x', trackingNumbers: null,
      shipped: false, cancelled: o.cancelled, buyerId: null, groupOnly: true,
    }));
    const reads = apply && userId ? await queueGapFill(userId, toRead) : { walmart: 0, costco: 0, amazon: 0 };
    const wouldRead = { walmart: 0, costco: 0, amazon: 0 };
    for (const o of toRead) {
      // Amazon's lookup is a tracking lookup: nothing to read for a cancelled order.
      if (o.platform === 'Amazon' && o.cancelled) continue;
      wouldRead[o.platform.toLowerCase() as keyof typeof wouldRead]++;
    }
    return Response.json({ apply, days, ...result.counts, byPlatform: result.byPlatform, written: result.written, pageReads: apply ? reads : wouldRead });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
