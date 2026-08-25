import { prisma, getSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { resolveExtensionUserId } from '@/lib/extensionAuth';
import { getMyTracker, getMyTrackerAll, deriveBfmrStatus, type TrackerFilter } from '@/lib/bfmr';
import { getWebTrackerRows, bfmrJoinKey, WEB_BACKFILL_FETCH } from '@/lib/bfmrWeb';
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

  // quick_filter's bucket coverage is undocumented and has already missed
  // reservations twice: 'action_needed' was missing entirely until added
  // 2026-07-31, and even with all 5 buckets below, a 'Purchased / Enter
  // tracking' reservation (confirmed live against BFMR's own portal,
  // 2026-08-23) was still invisible to every one of them, leaving its
  // myTrackerId permanently null no matter how many times sync ran.
  // BFMR's docs confirm quick_filter is ignored whenever status is set, so
  // one pass using the complete status enum (from BFMR's own spec) has no
  // bucket-semantics gap left to hit.
  const filters: TrackerFilter[] = [
    {
      status: 'purchased,reserved,return,payment_error,shipped,processed,set_aside,paid,cancelled,returned,closed,deadline,pkg_received',
      page_size: 200,
    },
  ];

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

  // Fallback: backfill myTrackerId from BFMR's Web App surface for
  // reservations the REST surface's status-enum sync still leaves null.
  // Confirmed live 2026-08-23 (order 880's Space Gray reservation): a
  // reservation with real BFMR data (my_tracker_id 4869593, status
  // "purchased") never appeared with a tracker id on the REST surface
  // despite a full 703-reservation sync -- genuinely two different BFMR
  // backends, not a REST query bug.
  //
  // Matching key: reserved_at + item model/name + qty + order_id. See
  // lib/bfmrJoin.ts bfmrJoinKey for the measured side-by-side that
  // establishes it, and for why each component is load-bearing.
  //
  // The previous key was `order_id|item_id|qty`, which could NEVER match:
  // item_id is opaque base64 on the REST surface and an integer on the Web
  // surface. Measured live 2026-08-25 it produced webBackfilled: 0 against
  // webNeeded: 681.
  //
  // Two other things were wrong with the old query and both are fixed here:
  //   - `bfmrOrderId: { not: null }` excluded exactly the rows this exists
  //     for. A reservation awaiting its FIRST order number has no
  //     bfmrOrderId, needs myTrackerId to get one pushed, and could
  //     therefore never be backfilled: you needed the order number to get
  //     the tracker id, and the tracker id to set the order number.
  //   - `itemId: { not: null }` is irrelevant now that itemId isn't in the
  //     key; the item identity comes from raw's item_model_number/item_name.
  //
  // Backfill ONLY when exactly one Web App row matches. Zero or more than
  // one match, and myTrackerId stays null -- "loudly wrong, not silently
  // wrong", same rule as the original my_tracker_id submit-time fix.
  const needsWebBackfill = await prisma.bfmrReservation.findMany({
    where: { userId: uid, myTrackerId: null },
    select: { id: true, bfmrOrderId: true, itemName: true, qty: true, raw: true },
  });

  let webBackfilled = 0;
  let webAmbiguous = 0;
  let webUnmatched = 0;
  // Diagnostics for the backfill itself. webBackfilled: 0 was previously
  // indistinguishable between "the Web surface returned rows but none of the
  // keys matched" and "the Web fetch failed and we swallowed it" -- the catch
  // below only console.warn'd, so a broken login looked exactly like a clean
  // no-op. Both were live possibilities on 2026-08-25 with myTrackerId null
  // on 708/708 reservations, and neither could be told apart from the outside.
  let webRowCount: number | null = null;
  let webError: string | null = null;
  const webKeySamples: string[] = [];
  const localKeySamples: string[] = [];
  if (needsWebBackfill.length > 0) {
    const [emailSetting, passwordSetting] = await Promise.all([
      getSetting(uid, 'bfmr_email'),
      getSetting(uid, 'bfmr_password'),
    ]);
    if (emailSetting?.value && passwordSetting?.value) {
      try {
        // Widest view BFMR serves, not the action_needed slice: that tab
        // returns 2 rows where 'all' over the same window returns 453, and
        // a reservation only needs its tracker id backfilled once.
        const webRows = await getWebTrackerRows(
          emailSetting.value, passwordSetting.value, uid, WEB_BACKFILL_FETCH,
        );
        webRowCount = webRows.length;
        const byKey = new Map<string, typeof webRows>();
        for (const row of webRows) {
          const key = bfmrJoinKey(row);
          if (webKeySamples.length < 5) webKeySamples.push(key);
          const arr = byKey.get(key) ?? [];
          arr.push(row);
          byKey.set(key, arr);
        }
        for (const r of needsWebBackfill) {
          // raw is the REST item verbatim and is the only place reserved_at
          // and item_model_number survive -- neither is a column. Fall back
          // to the columns we do have if raw is missing or unparseable, which
          // yields a key that simply won't match rather than a wrong one.
          let rawItem: Record<string, unknown> = {};
          if (r.raw) {
            try { rawItem = JSON.parse(r.raw) as Record<string, unknown>; } catch { rawItem = {}; }
          }
          const key = bfmrJoinKey({
            reserved_at: rawItem.reserved_at,
            item_model_number: rawItem.item_model_number,
            item_name: rawItem.item_name ?? r.itemName,
            qty: r.qty,
            order_id: r.bfmrOrderId,
          });
          if (localKeySamples.length < 5) localKeySamples.push(key);
          const matches = byKey.get(key) ?? [];
          if (matches.length === 1 && matches[0].my_tracker_id) {
            await prisma.bfmrReservation.update({
              where: { id: r.id },
              data: { myTrackerId: Number(matches[0].my_tracker_id) },
            });
            webBackfilled++;
          } else if (matches.length > 1) {
            webAmbiguous++;
          } else {
            webUnmatched++;
          }
        }
      } catch (e) {
        // Still non-fatal -- a Web-surface outage must not fail the whole
        // REST sync -- but it is no longer invisible. Silently swallowing
        // this is what made a broken backfill look like a working one.
        webError = String(e);
        console.warn(`[bfmr/sync-reservations] web-surface backfill failed, skipping: ${e}`);
      }
    }
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
    webBackfilled,
    // Rows where more than one Web App row shares the join key. Deliberately
    // left null rather than guessed -- see the join comment in lib/bfmrJoin.ts.
    webAmbiguous,
    // Rows with no Web App counterpart at all: mostly reservations older than
    // the 12-month window BFMR will serve. Non-zero is normal.
    webUnmatched,
    // webNeeded/webRows/webError separate the three ways backfill can produce
    // zero: nothing needed it, the Web surface gave us nothing, or it gave us
    // rows whose keys don't line up with ours. The key samples show which --
    // they are ids, not secrets.
    webNeeded: needsWebBackfill.length,
    webRows: webRowCount,
    ...(webError ? { webError } : {}),
    ...(webKeySamples.length ? { webKeySamples } : {}),
    ...(localKeySamples.length ? { localKeySamples } : {}),
    ...(collisionSamples.length ? { collisionSamples } : {}),
    // Non-zero means at least one order's payout is derived from a value
    // BFMR no longer agrees with. Samples are capped so the response stays
    // small on a large drift.
    staleLinkValues: staleLinks.length,
    ...(staleLinks.length ? { staleLinkValueSamples: staleLinks.slice(0, 10) } : {}),
  });
}
