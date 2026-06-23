import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getMyTracker, type TrackerFilter } from '@/lib/bfmr';

export const dynamic = 'force-dynamic';

function parseMoney(v: unknown): number | null {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

export async function POST() {
  const userId = await getSessionUserId();
  const uid = userId ?? null;
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });

  const [apiKeySetting, apiSecretSetting] = await Promise.all([
    prisma.setting.findFirst({ where: { userId: uid, key: 'bfmr_api_key' } }),
    prisma.setting.findFirst({ where: { userId: uid, key: 'bfmr_api_secret' } }),
  ]);
  if (!apiKeySetting?.value || !apiSecretSetting?.value) {
    return Response.json({ error: 'BFMR API credentials not configured' }, { status: 400 });
  }
  const creds = { apiKey: apiKeySetting.value, apiSecret: apiSecretSetting.value };

  const filters: TrackerFilter[] = [
    { quick_filter: 'all', page_size: 200 },
    { quick_filter: 'paid', page_size: 200 },
    { quick_filter: 'closed', page_size: 200 },
  ];

  const allItems = new Map<string, Record<string, unknown>>();
  for (const f of filters) {
    const items = await getMyTracker(creds, f);
    for (const item of items) {
      const key = String(item.reserve_id ?? item.purchase_id ?? item.shipment_id ?? '');
      if (key && !allItems.has(key)) allItems.set(key, item as Record<string, unknown>);
    }
  }

  let synced = 0;
  for (const item of allItems.values()) {
    const reserveId = item.reserve_id ? String(item.reserve_id) : null;
    if (!reserveId) continue;

    const datePaidRaw = item.date_paid ? new Date(String(item.date_paid)) : null;
    const datePaid = datePaidRaw && !isNaN(datePaidRaw.getTime()) ? datePaidRaw : null;

    await prisma.bfmrReservation.upsert({
      where: { userId_reserveId: { userId: uid, reserveId } },
      create: {
        userId: uid,
        reserveId,
        purchaseId: item.purchase_id ? String(item.purchase_id) : null,
        shipmentId: item.shipment_id ? String(item.shipment_id) : null,
        bfmrOrderId: item.order_id ? String(item.order_id) : null,
        trackingNumber: item.tracking_number ? String(item.tracking_number) : null,
        dealTitle: item.deal_title ? String(item.deal_title) : null,
        itemName: item.item_name ? String(item.item_name) : null,
        status: String(item.status ?? 'unknown'),
        qty: parseInt(String(item.qty ?? '1')) || 1,
        retailPrice: parseMoney(item.retail_price),
        totalPayout: parseMoney(item.total_payout),
        datePaid,
        raw: JSON.stringify(item),
        lastSyncedAt: new Date(),
      },
      update: {
        purchaseId: item.purchase_id ? String(item.purchase_id) : null,
        shipmentId: item.shipment_id ? String(item.shipment_id) : null,
        bfmrOrderId: item.order_id ? String(item.order_id) : null,
        trackingNumber: item.tracking_number ? String(item.tracking_number) : null,
        dealTitle: item.deal_title ? String(item.deal_title) : null,
        itemName: item.item_name ? String(item.item_name) : null,
        status: String(item.status ?? 'unknown'),
        qty: parseInt(String(item.qty ?? '1')) || 1,
        retailPrice: parseMoney(item.retail_price),
        totalPayout: parseMoney(item.total_payout),
        datePaid,
        raw: JSON.stringify(item),
        lastSyncedAt: new Date(),
      },
    });
    synced++;
  }

  return Response.json({ synced });
}
