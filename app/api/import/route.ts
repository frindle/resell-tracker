import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { submitTracking as bfmrSubmitTracking } from '@/lib/bfmrWeb';
import { autoSubmitTrackingForOrders } from '@/lib/autoSubmitTracking';
import { captureDeliveryPhoto } from '@/lib/deliveryPhoto';
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
  sourceUrl?: string;
  shippingAddress?: string;
  trackingNumbers?: string[];
  paymentLast4?: string; // scraped from order's payment-method line — used to auto-assign card when matching exactly one saved card
  noRushBonusPercent?: number; // Amazon No-Rush delivery bonus, e.g. 2 for "extra 2% on items using No-Rush delivery"
  deliveryPhotoUrl?: string; // signed URL to the carrier's proof-of-delivery image; downloaded server-side because the URL expires
};

function normalize(n: string | null | undefined): string {
  return (n ?? '').replace(/\D/g, '');
}

function isUselessDescription(desc: string | null | undefined): boolean {
  if (!desc) return true;
  const d = desc.trim().toLowerCase();
  return !d || d === 'walmart.com' || d === 'amazon.com' || d === 'costco.com';
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Extension-User-Id',
    },
  });
}

export async function POST(req: NextRequest) {
  try {
  // Extension passes user id via header; fall back to session
  const headerUserId = req.headers.get('X-Extension-User-Id');
  const userId = headerUserId ? parseInt(headerUserId) : await getSessionUserId();
  const parsed = await req.json();
  const rawRows: ImportRow[] = Array.isArray(parsed) ? parsed.filter((r): r is ImportRow => r !== null && typeof r === 'object') : [];
  console.log(`[import] received ${rawRows.length} rows, first:`, JSON.stringify(rawRows[0]).slice(0, 200));

  // Filter out rows with unparseable dates
  const dateFiltered = rawRows.filter(r => {
    if (!r.orderDate) return false;
    const d = new Date(r.orderDate);
    return !isNaN(d.getTime());
  });

  // Load blocked addresses, shipping rules, and skip list up front
  const [blockedPatterns, shippingRules, skipList] = await Promise.all([
    prisma.blockedAddress.findMany({ select: { pattern: true } }),
    prisma.shippingRule.findMany({ select: { pattern: true, buyerId: true } }),
    prisma.bfmrSkip.findMany({ select: { orderNumber: true } }),
  ]);
  const skipSet = new Set(skipList.map(s => normalize(s.orderNumber)));

  function matchBuyerId(addr: string | undefined): number | null {
    if (!addr) return null;
    const lower = addr.toLowerCase();
    const match = shippingRules.find(r => lower.includes(r.pattern.toLowerCase()));
    return match?.buyerId ?? null;
  }

  function matchedBlockedPattern(addr: string | undefined): string | null {
    if (!addr || blockedPatterns.length === 0) return null;
    const lower = addr.toLowerCase();
    const m = blockedPatterns.find(b => lower.includes(b.pattern.toLowerCase()));
    return m?.pattern ?? null;
  }

  // Don't drop blocked rows — quarantine them (ignoredByRule=true,
  // blockedAddressPattern set) so they show up on /orders/blocked for
  // user review and selective approval.
  const rows = dateFiltered;
  console.log(`[import] ${rows.length} rows after date filter`);

  // Fetch existing orders for this user, keyed by normalized order number
  const allExisting = await prisma.order.findMany({
    where: userId ? { userId } : { userId: null },
    select: {
      id: true,
      orderNumber: true,
      platform: true,
      itemDescription: true,
      sourceUrl: true,
      shippingAddress: true,
      trackingNumbers: true,
      buyerId: true,
      cardId: true,
      salePrice: true,
      cost: true,
      shippingCost: true,
      cashbackAmount: true,
    },
  });
  const existingByNorm = new Map(
    allExisting.filter(o => normalize(o.orderNumber)).map(o => [normalize(o.orderNumber), o])
  );

  const seenInBatch = new Set<string>();
  const toCreate: ImportRow[] = [];
  const toUpdate: { id: number; existing: typeof allExisting[0]; row: ImportRow }[] = [];
  let skipped = 0;

  for (const r of rows) {
    const norm = normalize(r.orderNumber);
    // Orders without a number always create a new record
    if (!norm) {
      toCreate.push(r);
      continue;
    }
    if (seenInBatch.has(norm)) {
      skipped++;
      continue;
    }
    seenInBatch.add(norm);

    const existing = existingByNorm.get(norm);
    if (existing) {
      toUpdate.push({ id: existing.id, existing, row: r });
    } else if (!skipSet.has(norm)) {
      toCreate.push(r);
    } else {
      skipped++;
    }
  }

  // Build a last4 → cardId map so we can auto-assign a card on import when
  // the scraped payment-method line (paymentLast4) matches exactly one of
  // the user's saved cards. Cards without last4 set are ignored. If two
  // cards share the same last 4 digits, neither auto-assigns (ambiguous).
  const userCards = await prisma.creditCard.findMany({
    where: { userId: userId ?? null, last4: { not: null } },
    select: { id: true, last4: true },
  });
  const last4ToCardId = new Map<string, number | null>();
  for (const c of userCards) {
    if (!c.last4) continue;
    if (last4ToCardId.has(c.last4)) last4ToCardId.set(c.last4, null); // duplicate → don't auto-assign
    else last4ToCardId.set(c.last4, c.id);
  }
  console.log(`[import] card auto-assign map: ${userCards.length} cards w/ last4, ${last4ToCardId.size} unique, dups=${[...last4ToCardId.entries()].filter(([, v]) => v === null).map(([k]) => k).join(',') || 'none'}`);

  function resolveCardId(r: ImportRow): number | null {
    if (r.cardId) return parseInt(r.cardId); // explicit wins
    if (r.paymentLast4) {
      const match = last4ToCardId.get(r.paymentLast4);
      if (match) {
        console.log(`[import] auto-assign ${r.platform} #${r.orderNumber}: last4=${r.paymentLast4} → card ${match}`);
        return match;
      }
      console.log(`[import] no card auto-assign for ${r.platform} #${r.orderNumber}: last4=${r.paymentLast4} (${last4ToCardId.has(r.paymentLast4) ? 'duplicate' : 'no saved card matches'})`);
    } else {
      console.log(`[import] no paymentLast4 scraped for ${r.platform} #${r.orderNumber}`);
    }
    return null;
  }

  // Fields we track for sync-history diffs. Order matters only for stable
  // display in the UI.
  const DIFFED_FIELDS = [
    'platform', 'orderNumber', 'itemDescription', 'cost', 'shippingCost',
    'salePrice', 'buyerId', 'cardId', 'cashbackAmount', 'sourceUrl',
    'shippingAddress', 'trackingNumbers',
  ] as const;

  const [created, updated] = await Promise.all([
    Promise.all(
      toCreate.map(r => {
        const resolvedBuyerId = r.buyerId ? parseInt(r.buyerId) : matchBuyerId(r.shippingAddress);
        const blockedPattern = matchedBlockedPattern(r.shippingAddress);
        return prisma.order.create({
          data: {
            userId: userId ?? null,
            platform: r.platform,
            orderNumber: r.orderNumber || null,
            orderDate: new Date(r.orderDate),
            itemDescription: isUselessDescription(r.itemDescription) ? null : r.itemDescription,
            cost: r.cost,
            shippingCost: r.shippingCost,
            salePrice: r.salePrice ?? null,
            buyerId: resolvedBuyerId,
            cardId: resolveCardId(r),
            cashbackAmount: r.cashbackAmount,
            sourceUrl: r.sourceUrl || null,
            shippingAddress: r.shippingAddress || null,
            trackingNumbers: r.trackingNumbers?.join(',') || null,
            skipAddressBlock: true,
            ignoredByRule: blockedPattern != null,
            blockedAddressPattern: blockedPattern,
            ...(r.noRushBonusPercent != null ? { delayedShipping: true, noRushBonusPercent: r.noRushBonusPercent } : {}),
          },
        });
      })
    ),
    Promise.all(
      toUpdate.map(({ id, existing, row: r }) => {
        const incomingTracking = r.trackingNumbers?.join(',') || null;
        // If the scrape brings a different tracking value than what we
        // have on file, reset trackingSubmittedToBg so autoSubmit
        // re-attempts. Without this, a scraper-discovered tracking on
        // an order that was previously marked submitted (e.g. the user
        // ran a one-time backfill, or an earlier scrape submitted an
        // older value) would never reach BG/BS.
        const isRealTrackingCheck = (t: string | null) => !!(t && /TBA\d{10,}|1Z[A-Z0-9]{16}|9[0-9]{19,21}|55[0-9]{10,}/.test(t));
        const trackingMaterialChange = isRealTrackingCheck(incomingTracking) && incomingTracking !== existing.trackingNumbers;
        const isRealTracking = (t: string | null) => !!(t && /TBA\d{10,}|1Z[A-Z0-9]{16}|9[0-9]{19,21}|55[0-9]{10,}/.test(t));
        // Walmart store deliveries/pickups use the order number as the tracking
        // identifier — treat it as valid tracking so it doesn't get dropped.
        const isOrderNumberTracking = (t: string | null) => {
          if (!t || !existing.orderNumber) return false;
          const tNorm = t.replace(/\D/g, '');
          const oNorm = existing.orderNumber.replace(/\D/g, '');
          return tNorm.length > 0 && tNorm === oNorm;
        };
        const isValidTracking = (t: string | null) => isRealTracking(t) || isOrderNumberTracking(t);
        // Real tracking always wins. If incoming is empty / not-valid, leave
        // the existing value alone — used to detect "fake" order-number
        // tracking from the v1.1.43 extension bug and clear it on update,
        // but v1.1.49 stopped writing fake fallbacks and the one-shot
        // cleanup endpoint scrubbed legacy values. Anything order-number
        // shaped that's still in the DB now is a user's manual entry
        // (e.g. Walmart store delivery), so don't touch it.
        const resolvedTracking = isValidTracking(incomingTracking)
          ? incomingTracking
          : isValidTracking(existing.trackingNumbers)
            ? undefined
            : (incomingTracking ?? undefined);
        const resolvedBuyerId = existing.buyerId
          ?? (r.buyerId ? parseInt(r.buyerId) : matchBuyerId(r.shippingAddress ?? existing.shippingAddress ?? undefined));
        return prisma.order.update({
          where: { id },
          data: {
            // Upgrade platform from 'Other' (BFMR imports) to the real retailer when scraped
            ...(existing.platform === 'Other' && r.platform !== 'Other' ? { platform: r.platform } : {}),
            itemDescription: isUselessDescription(existing.itemDescription) ? (isUselessDescription(r.itemDescription) ? null : r.itemDescription) : existing.itemDescription,
            sourceUrl: existing.sourceUrl ?? (r.sourceUrl || null),
            shippingAddress: existing.shippingAddress || (r.shippingAddress || null),
            trackingNumbers: resolvedTracking,
            salePrice: existing.salePrice ?? r.salePrice,
            buyerId: resolvedBuyerId,
            cardId: existing.cardId ?? resolveCardId(r),
            cost: (existing.cost !== 0 && existing.cost != null) ? existing.cost : r.cost,
            shippingCost: (existing.shippingCost !== 0 && existing.shippingCost != null) ? existing.shippingCost : r.shippingCost,
            cashbackAmount: existing.cashbackAmount !== 0 ? existing.cashbackAmount : r.cashbackAmount,
            skipAddressBlock: true,
            ...(trackingMaterialChange ? { trackingSubmittedToBg: false } : {}),
            ...(r.noRushBonusPercent != null ? { delayedShipping: true, noRushBonusPercent: r.noRushBonusPercent } : {}),
          },
        });
      })
    ),
  ]);

  // Count "verified" — orders that hit the update path but had zero field
  // changes. This is so the extension banner can say "verified" instead of
  // "updated" when nothing actually changed.
  let verifiedCount = 0;
  let updatedWithChangesCount = 0;
  for (let i = 0; i < toUpdate.length; i++) {
    const { existing } = toUpdate[i];
    const updatedOrder = updated[i];
    let changed = false;
    for (const f of DIFFED_FIELDS) {
      const before = (existing as Record<string, unknown>)[f];
      const after  = (updatedOrder as Record<string, unknown>)[f];
      const a = before instanceof Date ? before.toISOString() : before;
      const b = after  instanceof Date ? after.toISOString()  : after;
      if (a !== b) { changed = true; break; }
    }
    if (changed) updatedWithChangesCount++; else verifiedCount++;
  }

  // Persist a sync-history event so the user can see what was touched.
  // Only logs when at least one row was created or updated — skipped-only
  // calls (polling no-ops) are noise.
  let eventId: number | null = null;
  if (created.length || updated.length) {
    const platforms = new Set<string>();
    for (const r of [...toCreate, ...toUpdate.map(u => u.row)]) platforms.add(r.platform);
    const platform = platforms.size === 1 ? [...platforms][0] : 'Mixed';

    const orderChanges: { orderId: number; orderNumber: string | null; action: string; changedFields: string }[] = [];

    // Fire-and-forget delivery photo downloads. Signed URLs expire (Amazon
    // 3-day TTL, Walmart proxy similar), so we grab them now while they're
    // still valid. Idempotent on the server side — won't double-attach.
    // Log every URL arrival (+ a summary count when none) so we can tell
    // from docker logs alone whether the extension is sending them.
    const photoRows = [...toCreate, ...toUpdate.map(u => u.row)].filter(r => r.deliveryPhotoUrl);
    if (photoRows.length > 0) {
      console.log(`[import] ${photoRows.length} rows with deliveryPhotoUrl: ${photoRows.map(r => `${r.platform} ${r.orderNumber}`).join(', ')}`);
    } else if (rawRows.length > 0) {
      console.log(`[import] no deliveryPhotoUrl on any of ${rawRows.length} rows (extension didn't extract)`);
    }
    for (let i = 0; i < toCreate.length; i++) {
      const row = toCreate[i];
      const order = created[i];
      if (row.deliveryPhotoUrl && order?.id) {
        void captureDeliveryPhoto(order.id, row.deliveryPhotoUrl, row.platform);
      }
    }
    for (let i = 0; i < toUpdate.length; i++) {
      const { row } = toUpdate[i];
      const order = updated[i];
      if (row.deliveryPhotoUrl && order?.id) {
        void captureDeliveryPhoto(order.id, row.deliveryPhotoUrl, row.platform);
      }
    }

    for (let i = 0; i < toCreate.length; i++) {
      const row = toCreate[i];
      const newOrder = created[i];
      const fields: Record<string, [unknown, unknown]> = {};
      for (const f of DIFFED_FIELDS) {
        // Read the value from the row so the diff reflects what the importer
        // actually intended (post-isUseless filter applied at write time isn't
        // worth re-deriving here; show the raw input).
        const v =
          f === 'trackingNumbers' ? (row.trackingNumbers?.join(',') || null)
          : (row as Record<string, unknown>)[f];
        if (v !== undefined && v !== null && v !== '' && v !== 0) {
          fields[f] = [null, v];
        }
      }
      orderChanges.push({
        orderId: newOrder.id,
        orderNumber: newOrder.orderNumber,
        action: 'created',
        changedFields: JSON.stringify(fields),
      });
    }

    for (let i = 0; i < toUpdate.length; i++) {
      const { existing, row } = toUpdate[i];
      const updatedOrder = updated[i];
      const fields: Record<string, [unknown, unknown]> = {};
      for (const f of DIFFED_FIELDS) {
        const before = (existing as Record<string, unknown>)[f];
        const after  = (updatedOrder as Record<string, unknown>)[f];
        // Normalize date/Decimal-ish to JSON-comparable scalars
        const a = before instanceof Date ? before.toISOString() : before;
        const b = after  instanceof Date ? after.toISOString()  : after;
        if (a !== b) fields[f] = [a ?? null, b ?? null];
      }
      if (Object.keys(fields).length > 0) {
        orderChanges.push({
          orderId: updatedOrder.id,
          orderNumber: updatedOrder.orderNumber,
          action: 'updated',
          changedFields: JSON.stringify(fields),
        });
      }
    }

    const event = await prisma.syncEvent.create({
      data: {
        userId: userId ?? null,
        platform,
        scraped: rawRows.length,
        imported: created.length,
        updated: updated.length,
        skipped,
        orderChanges: { create: orderChanges },
      },
      select: { id: true },
    });
    eventId = event.id;
  }

  // Auto-submit newly-arrived tracking numbers to buying groups (fire and forget)
  void (async () => {
    try {
      const candidateIds = [
        ...created.filter(o => o.trackingNumbers).map(o => o.id),
        ...updated.filter(o => o.trackingNumbers && !o.trackingSubmittedToBg).map(o => o.id),
      ];
      console.log(`[bg-submit/import] candidates: ${candidateIds.length} (${created.filter(o => o.trackingNumbers).length} created, ${updated.filter(o => o.trackingNumbers && !o.trackingSubmittedToBg).length} updated)`);
      await autoSubmitTrackingForOrders(userId ?? null, candidateIds, 'import');

      // BFMR auto-submit DISABLED June 2026.
      //
      // BFMR exposes one row per shipment for split orders, each row showing
      // its own item/qty breakdown. Auto-matching our captured tracking
      // numbers to those rows by order_id alone risks assigning the wrong
      // tracking to a row when shipments split. Until we have a verified
      // match (item-count, carrier, or user-confirmed), don't push.
      //
      // Submission still works from the manual /api/bfmr/push-tracking and
      // /api/orders/submit-tracking endpoints — those will be re-pointed at
      // a new BFMR submission review UI (see TODO).
    } catch { /* don't let tracking submission failure affect import */ }
  })();

  return new Response(JSON.stringify({ imported: created.length, updated: updatedWithChangesCount, verified: verifiedCount, skipped, eventId }), {
    status: 201,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
  } catch (e) {
    console.error('[import] error:', e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}
