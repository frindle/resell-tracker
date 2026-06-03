import { getSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getMyTracker } from '@/lib/bfmr';
import { prisma } from '@/lib/db';
import { NextRequest } from 'next/server';
import type { TrackerItem } from '@/lib/bfmr';

function normalize(n: string | null | undefined): string {
  return (n ?? '').replace(/\D/g, '');
}
function parseMoney(v: unknown): number | null {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return new Response('Unauthorized', { status: 401 });
  const uid = userId;

  let force = false;
  try { const b = await req.json(); force = b.force === true; } catch { /* no body */ }

  const [k, s] = await Promise.all([
    getSetting(uid, 'bfmr_api_key'),
    getSetting(uid, 'bfmr_api_secret'),
  ]);
  if (!k?.value || !s?.value) return new Response('BFMR not configured', { status: 400 });
  const creds = { apiKey: k.value, apiSecret: s.value };

  let items: TrackerItem[];
  try {
    items = await getMyTracker(creds);
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }

  // Filter by sync start date if configured
  const syncStartSetting = await prisma.setting.findFirst({ where: { userId: uid, key: 'bfmr_sync_start_date' } });
  if (syncStartSetting?.value) {
    const cutoff = new Date(syncStartSetting.value);
    items = items.filter(i => {
      const d = i.reserved_at ? new Date(String(i.reserved_at)) : null;
      return d == null || d >= cutoff;
    });
  }

  const PAID_STATUSES = new Set(['paid', 'payment_sent', 'complete', 'completed']);
  const RECEIVED_STATUSES = new Set(['pkg_received', 'received', 'processed']);
  const IMPORT_STATUSES = new Set(['paid', 'payment_sent', 'complete', 'completed', 'pkg_received', 'received', 'processed', 'shipped', 'purchased']);
  const IGNORE_STATUSES = new Set(['cancelled', 'returned', 'return', 'set_aside', 'closed']);

  const withOrderNo = items.filter(i => i.order_id);

  const bfmrBuyer = await prisma.buyer.findFirst({ where: { name: { contains: 'BFMR' } } });
  const skipList = await prisma.bfmrSkip.findMany({ select: { orderNumber: true } });
  const skipSet = new Set(skipList.map(s => normalize(s.orderNumber)));

  const existing = await prisma.order.findMany({
    where: { userId: uid },
    select: { id: true, orderNumber: true, trackingNumbers: true, salePrice: true, salePriceSynced: true, bgExpectedPayout: true, bgPaidAmount: true, buyerId: true, overdueAt: true },
  });
  const existingByNorm = new Map(
    existing.filter(o => normalize(o.orderNumber)).map(o => [normalize(o.orderNumber!), o])
  );

  const grouped = new Map<string, TrackerItem[]>();
  for (const item of withOrderNo) {
    const norm = normalize(item.order_id as string);
    if (!grouped.has(norm)) grouped.set(norm, []);
    grouped.get(norm)!.push(item);
  }

  let updated = 0, created = 0, unmatched = 0;
  const STATUS_RANK: Record<string, number> = { paid: 5, payment_sent: 5, complete: 5, completed: 5, pkg_received: 4, received: 4, processed: 4, shipped: 3, purchased: 2 };

  for (const [norm, group] of grouped) {
    const bestItem = group.reduce((a, b) => (STATUS_RANK[String(b.status ?? '').toLowerCase()] ?? 0) > (STATUS_RANK[String(a.status ?? '').toLowerCase()] ?? 0) ? b : a);
    const status = String(bestItem.status ?? '').toLowerCase();
    const activeItems = group.filter(i => !IGNORE_STATUSES.has(String(i.status ?? '').toLowerCase()));
    const totalPayoutRaw = activeItems.reduce((sum, i) => sum + (parseMoney(i.total_payout) ?? 0), 0);
    const totalPayout = activeItems.length > 0 ? totalPayoutRaw : null;
    const order = existingByNorm.get(norm);

    if (!order) {
      if (IMPORT_STATUSES.has(status) && !IGNORE_STATUSES.has(status) && !skipSet.has(norm)) {
        const isPaid = PAID_STATUSES.has(status);
        const isAmazonOrder = /^\d{3}-\d{7}-\d{7}$/.test(String(bestItem.order_id));
        const reservedAt = bestItem.reserved_at ? new Date(String(bestItem.reserved_at)) : new Date();
        const trackingNums = [...new Set(group.map(i => i.tracking_number).filter(Boolean))].join(', ');
        await prisma.order.create({
          data: {
            userId: uid,
            platform: isAmazonOrder ? 'Amazon' : 'Other',
            orderNumber: String(bestItem.order_id),
            orderDate: reservedAt,
            itemDescription: String(bestItem.item_name ?? bestItem.deal_title ?? ''),
            cost: 0,
            trackingNumbers: trackingNums || null,
            buyerId: bfmrBuyer?.id ?? null,
            salePrice: isPaid && totalPayout != null ? totalPayout : null,
            salePriceSynced: isPaid,
            bgExpectedPayout: totalPayout,
            notes: 'Imported from BFMR – add cost, card, and shipping info',
          },
        });
        created++;
      } else {
        unmatched++;
      }
      continue;
    }

    const isPaid = PAID_STATUSES.has(status);
    const isReceived = RECEIVED_STATUSES.has(status);
    const receivedAt = bestItem.date_processed ? new Date(String(bestItem.date_processed)) : null;
    const isOverdue = isReceived && receivedAt != null && Date.now() - receivedAt.getTime() > 14 * 24 * 60 * 60 * 1000 && !isPaid;

    const patch: Record<string, unknown> = {};
    if (totalPayout != null && (force || order.bgExpectedPayout == null)) patch.bgExpectedPayout = totalPayout;
    if (isPaid && totalPayout != null && (!order.salePriceSynced || force)) {
      patch.salePrice = totalPayout;
      patch.salePriceSynced = true;
      patch.bgPaidAmount = totalPayout;
    }
    if (isPaid && order.overdueAt) patch.overdueAt = null;
    if (isOverdue && !order.overdueAt) patch.overdueAt = new Date();
    if (order.buyerId == null && bfmrBuyer) patch.buyerId = bfmrBuyer.id;
    const bfmrTracking = [...new Set(group.map(i => i.tracking_number).filter(Boolean))].join(', ');
    if (bfmrTracking && !order.trackingNumbers) patch.trackingNumbers = bfmrTracking;

    if (Object.keys(patch).length > 0) {
      await prisma.order.update({ where: { id: order.id }, data: patch });
      updated++;
    }
  }

  return Response.json({ updated, created, unmatched, total: items.length });
}
