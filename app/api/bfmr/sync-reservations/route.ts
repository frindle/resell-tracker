import { prisma, getSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { resolveExtensionUserId } from '@/lib/extensionAuth';
import { getMyTracker, getMyTrackerAll, deriveBfmrStatus, type TrackerFilter } from '@/lib/bfmr';
import { autoLinkBfmrReservations } from '@/lib/bfmrAutoLink';
import { findStaleBfmrLinkValues } from '@/lib/bfmrSalePrice';

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
  const filterResults = await Promise.all(filters.map(f => getMyTrackerAll(creds, f)));
  const allItems = new Map<string, Record<string, unknown>>();
  // Dedup is FIRST-WINS on reserve_id, which is correct only if BFMR never
  // returns two distinct line items under one reserve_id. That assumption has
  // never been verified, and the local schema bakes it in a second time via
  // @@unique([userId, reserveId]) -- so if it is wrong, a colliding line is
  // dropped here and would be overwritten by the upsert even if it survived.
  //
  // Rather than guess, count the collisions and report them. If
  // reserveIdCollisions comes back 0 after a full paginated sync, the
  // assumption holds and pagination was the whole bug. If it comes back
  // non-zero, the unique key is wrong and needs a migration to include a
  // per-line discriminator (my_tracker_id). Do not change the schema on
  // suspicion -- make the sync say which it is.
  let rawItemCount = 0;
  let reserveIdCollisions = 0;
  const collisionSamples: string[] = [];
  for (const items of filterResults) {
    for (const item of items) {
      rawItemCount++;
      const key = String(item.reserve_id ?? item.purchase_id ?? item.shipment_id ?? '');
      if (!key) continue;
      const existing = allItems.get(key);
      if (!existing) {
        allItems.set(key, item as Record<string, unknown>);
        continue;
      }
      // Same key seen again. Identical row re-fetched under another filter is
      // expected and harmless; a genuinely DIFFERENT line item is the bug.
      const sameLine =
        String(existing.my_tracker_id ?? '') === String((item as Record<string, unknown>).my_tracker_id ?? '') &&
        String(existing.qty ?? '') === String((item as Record<string, unknown>).qty ?? '');
      if (!sameLine) {
        reserveIdCollisions++;
        if (collisionSamples.length < 10) {
          collisionSamples.push(
            `${key}: kept qty=${existing.qty} tracker=${existing.my_tracker_id} / dropped qty=${(item as Record<string, unknown>).qty} tracker=${(item as Record<string, unknown>).my_tracker_id}`,
          );
        }
      }
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

  // This sync is the moment reservation payouts change, so it's also the
  // moment link value snapshots go stale. OrderBfmrLink.value is captured at
  // link time and never re-synced, and recalcBfmrSalePrice sums those
  // snapshots — a revised reservation therefore moves an order's payout with
  // nothing to show for it (order 880: a link holding 1460 against a
  // reservation worth 2190, $730 short). Report the drift here rather than
  // rewriting it: value is user-editable, so a re-derive would overwrite
  // hand-entered corrections. The linker offers a per-link "use BFMR's
  // number" button for the ones that really are stale.
  const staleLinks = await findStaleBfmrLinkValues(uid);
  for (const s of staleLinks) {
    console.warn(
      `[bfmr/sync-reservations] stale link value: link ${s.linkId} (order ${s.orderId}, reservation ${s.reservationId}) value ${s.actual} vs current share ${s.expected} for ${s.linkQuantity}/${s.reservationQty} units (delta ${s.delta})`,
    );
  }

  // fetched/unique are the diagnostic pair. Before pagination they were
  // capped at 5 x page_size; a fetched count above that is proof the tail was
  // previously being dropped. reserveIdCollisions answers the open question
  // about whether @@unique([userId, reserveId]) is a valid assumption --
  // non-zero means it is not, and the schema needs a per-line discriminator.
  return Response.json({
    synced,
    autoLinked,
    fetched: rawItemCount,
    unique: allItems.size,
    reserveIdCollisions,
    ...(collisionSamples.length ? { collisionSamples } : {}),
    // Non-zero means at least one order's payout is derived from a value
    // BFMR no longer agrees with. Samples are capped so the response stays
    // small on a large drift.
    staleLinkValues: staleLinks.length,
    ...(staleLinks.length ? { staleLinkValueSamples: staleLinks.slice(0, 10) } : {}),
  });
}
