import { prisma, getSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { resolveExtensionUserId } from '@/lib/extensionAuth';
import { getMyTracker, deriveBfmrStatus, type TrackerFilter } from '@/lib/bfmr';
import { autoLinkBfmrReservations } from '@/lib/bfmrAutoLink';

export const dynamic = 'force-dynamic';

function parseMoney(v: unknown): number | null {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

export async function POST(req: Request) {
  const sessionUid = await getSessionUserId();
  // Same non-session caller support as the CC sync route — used by the
  // extension and the in-process auto-sync scheduler (loopback).
  const uid = resolveExtensionUserId(req, sessionUid);
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });

  const [apiKeySetting, apiSecretSetting] = await Promise.all([
    getSetting(uid, 'bfmr_api_key'),
    getSetting(uid, 'bfmr_api_secret'),
  ]);
  if (!apiKeySetting?.value || !apiSecretSetting?.value) {
    return Response.json({ error: 'BFMR API credentials not configured' }, { status: 400 });
  }
  const creds = { apiKey: apiKeySetting.value, apiSecret: apiSecretSetting.value };

  const filters: TrackerFilter[] = [
    // 'all' is not actually comprehensive on BFMR's side — reservations
    // sitting in the 'action_needed' bucket (e.g. purchased but tracking
    // not yet submitted, exactly the state this sync is meant to resolve)
    // were never being fetched, so a reservation stuck needing tracking
    // could never pick up the purchaseId/myTrackerId/dealId/itemId it
    // needs to actually submit, no matter how many times sync ran.
    // Confirmed live 2026-07-31.
    { quick_filter: 'all', page_size: 200 },
    { quick_filter: 'pending', page_size: 200 },
    { quick_filter: 'action_needed', page_size: 200 },
    { quick_filter: 'paid', page_size: 200 },
    { quick_filter: 'closed', page_size: 200 },
  ];

  // Parallel, not sequential: 5 filters at up to 30s each run sequentially
  // could take 150s worst case, which is longer than Cloudflare's ~100s
  // proxy timeout for this tunnel-routed hostname — the browser got
  // Cloudflare's own HTML error page back instead of JSON when that
  // happened. Confirmed live 2026-07-31.
  const filterResults = await Promise.all(filters.map(f => getMyTracker(creds, f)));
  const allItems = new Map<string, Record<string, unknown>>();
  for (const items of filterResults) {
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

    const internalKey = item.key ? String(item.key) : null;
    await prisma.bfmrReservation.upsert({
      where: { userId_reserveId: { userId: uid, reserveId } },
      create: {
        userId: uid,
        reserveId,
        internalKey,
        purchaseId: item.purchase_id ? String(item.purchase_id) : null,
        shipmentId: item.shipment_id ? String(item.shipment_id) : null,
        bfmrOrderId: item.order_id ? String(item.order_id) : null,
        trackingNumber: item.tracking_number ? String(item.tracking_number) : null,
        dealTitle: item.deal_title ? String(item.deal_title) : null,
        itemName: item.item_name ? String(item.item_name) : null,
        status: deriveBfmrStatus(item),
        qty: parseInt(String(item.qty ?? '1')) || 1,
        retailPrice: parseMoney(item.retail_price),
        totalPayout: parseMoney(item.total_payout),
        datePaid,
        raw: JSON.stringify(item),
        lastSyncedAt: new Date(),
        // Fields needed at tracking-submission time. itemId/dealId are
        // opaque encoded strings on BFMR's side, not integers.
        myTrackerId: item.my_tracker_id ? Number(item.my_tracker_id) : null,
        itemId: item.item_id ? String(item.item_id) : null,
        dealId: item.deal_id ? String(item.deal_id) : null,
      },
      update: {
        internalKey,
        purchaseId: item.purchase_id ? String(item.purchase_id) : null,
        shipmentId: item.shipment_id ? String(item.shipment_id) : null,
        bfmrOrderId: item.order_id ? String(item.order_id) : null,
        trackingNumber: item.tracking_number ? String(item.tracking_number) : null,
        dealTitle: item.deal_title ? String(item.deal_title) : null,
        itemName: item.item_name ? String(item.item_name) : null,
        status: deriveBfmrStatus(item),
        qty: parseInt(String(item.qty ?? '1')) || 1,
        retailPrice: parseMoney(item.retail_price),
        totalPayout: parseMoney(item.total_payout),
        datePaid,
        raw: JSON.stringify(item),
        lastSyncedAt: new Date(),
        myTrackerId: item.my_tracker_id ? Number(item.my_tracker_id) : null,
        itemId: item.item_id ? String(item.item_id) : null,
        dealId: item.deal_id ? String(item.deal_id) : null,
      },
    });
    synced++;
  }

  // Auto-link freshly-synced reservations to local orders (by BFMR order id
  // or tracking number) and refresh sale prices on anything that got a link.
  const autoLinked = await autoLinkBfmrReservations(uid);

  return Response.json({ synced, autoLinked });
}
