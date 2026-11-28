import { prisma, getSetting } from '@/lib/db';
import { getBgAccessToken } from '@/lib/bgAuth';
import { getCommitments } from '@/lib/buyinggroup';
import { checkSyncGuard } from '@/lib/bgSyncGuard';
import { sameTerms, unitPrice, parseCommitmentTerms, commitmentFulfilledAt, type PriceTerms } from '@/lib/bgPriceChange';
import { repriceCommitmentOrders, notifyPriceChange, worthTelling } from '@/lib/commitmentReprice';
import { bgPayoutTiers, underpaidTier, tierShortText, TIER_GRACE_MS } from '@/lib/bgPayoutTiers';
import { sendPushover } from '@/lib/pushover';

// Sync the user's BuyingGroup commitments into our DB. Upserts by
// (userId, commitmentId). Shared by the sync route and the import's pre-match refresh.
export async function syncBgCommitments(uid: number): Promise<Response> {
    let token: string;
  try {
    token = await getBgAccessToken(uid);
  } catch (e) {
    return Response.json({ error: `BG auth failed: ${String(e)}` }, { status: 401 });
  }

  // Paginate through all commitments. BG's get_commitments takes page +
  // page_size; loop until we've fetched everything reported in count.
  const commitments: Awaited<ReturnType<typeof getCommitments>>['commitments'] = [];
  try {
    // count is null when BG's response carries no total (current paginated
    // format): page until an empty page or one that adds no new commitment
    // (guards against BG ignoring `page` and returning page 1 forever).
    const seen = new Set<string>();
    let page = 1;
    while (true) {
      const { commitments: batch, count } = await getCommitments(token, page, 100);
      const fresh = batch.filter(c => !seen.has(c.commitment_id));
      for (const c of fresh) seen.add(c.commitment_id);
      commitments.push(...fresh);
      if (batch.length === 0 || fresh.length === 0) break;
      if (count != null && commitments.length >= count) break;
      page++;
      if (page > 50) break; // safety cap — 5000 commitments shouldn't be possible
    }
  } catch (e) {
    return Response.json({ error: `BG fetch failed: ${String(e)}` }, { status: 502 });
  }

  // Pull the current state of every commitment for this user so we can log
  // count/fulfilled diffs per row. Without this it's impossible to tell from
  // docker logs whether BG is returning stale data or our upsert is wrong.
  const existing = await prisma.buyingGroupCommitment.findMany({
    where: { userId: uid },
    select: { id: true, commitmentId: true, count: true, fulfilled: true, status: true, price: true, commission: true, pendingPrice: true, pendingCommission: true, fulfilledAt: true },
  });
  const guard = checkSyncGuard(commitments.length, existing.length);
  if (guard) return guard;
  const existingByCmId = new Map(existing.map(e => [e.commitmentId, e]));
  const seenCmIds = new Set<string>();

  let upserted = 0;
  let changed = 0;
  const syncedAt = new Date();
  // BuyingGroup moved a commitment's price or commission: its linked orders'
  // sale prices are re-figured once every row is written.
  const priceChanges: { id: number; commitmentId: string; from: PriceTerms; to: PriceTerms }[] = [];
  for (const c of commitments) {
    // Parse "MM-DD-YYYY" → Date. BG uses US-style format.
    const expiryDay = parseUsDate(c.expiry_day);
    const createdDt = parseUsDateTime(c.created_dt);
    const total = parseFloat(c.total) || 0;

    seenCmIds.add(c.commitment_id);
    const prev = existingByCmId.get(c.commitment_id);
    // A price or commission that is missing or not a number is not a price change: keep the previous terms
    // (a new row has none, so it stores 0).
    const parsed = parseCommitmentTerms(c.price, c.commission);
    const price = parsed?.price ?? prev?.price ?? 0;
    const commission = parsed?.commission ?? prev?.commission ?? 0;
    // When this sync first sees every unit in: the date a tiered payout is judged by. A commitment first
    // seen already fulfilled gets no date (when it filled is unknown).
    const fulfilledAt = commitmentFulfilledAt(prev, c, syncedAt);
    if (prev) {
      const countDiff = prev.count !== c.count;
      const fulDiff = prev.fulfilled !== c.fulfilled;
      const statusDiff = prev.status !== (c.status ?? 'UNKNOWN');
      const from = { price: prev.price, commission: prev.commission };
      const to = { price, commission };
      const priceDiff = parsed != null && !sameTerms(from, to);
      if (priceDiff) priceChanges.push({ id: prev.id, commitmentId: c.commitment_id, from, to });
      if (countDiff || fulDiff || statusDiff || priceDiff) {
        changed++;
        console.log(
          `[bg/sync-commitments] ${c.commitment_id} changed:` +
          (countDiff ? ` count ${prev.count}→${c.count}` : '') +
          (fulDiff ? ` fulfilled ${prev.fulfilled}→${c.fulfilled}` : '') +
          (statusDiff ? ` status ${prev.status}→${c.status ?? 'UNKNOWN'}` : '') +
          (priceDiff ? ` unit ${unitPrice(from).toFixed(2)}→${unitPrice(to).toFixed(2)}` : '')
        );
      }
    } else {
      console.log(`[bg/sync-commitments] ${c.commitment_id} NEW count=${c.count} status=${c.status ?? 'UNKNOWN'}`);
    }

    await prisma.buyingGroupCommitment.upsert({
      where: { userId_commitmentId: { userId: uid, commitmentId: c.commitment_id } },
      create: {
        userId: uid,
        commitmentId: c.commitment_id,
        dealId: c.deal_id,
        dealTitle: c.deal?.title ?? '',
        itemId: c.item?.item_id ?? null,
        itemImage: c.item?.image_new ?? null,
        count: c.count,
        fulfilled: c.fulfilled,
        expiryDay,
        price,
        commission,
        total,
        bgPointsReward: c.bg_points_reward ?? 0,
        status: c.status ?? 'UNKNOWN',
        createdDt,
        raw: JSON.stringify(c),
      },
      update: {
        dealTitle: c.deal?.title ?? '',
        itemId: c.item?.item_id ?? null,
        itemImage: c.item?.image_new ?? null,
        count: c.count,
        fulfilled: c.fulfilled,
        expiryDay,
        price,
        commission,
        total,
        bgPointsReward: c.bg_points_reward ?? 0,
        status: c.status ?? 'UNKNOWN',
        raw: JSON.stringify(c),
        fulfilledAt,
        lastSyncedAt: new Date(),
        // The price change an email said was coming is here.
        ...(parsed != null && prev?.pendingPrice != null && sameTerms({ price, commission }, { price: prev.pendingPrice, commission: prev.pendingCommission ?? commission })
          ? { pendingPrice: null, pendingCommission: null, pendingAt: null }
          : {}),
      },
    });
    upserted++;
  }

  // Catch the inverse: rows we had locally that BG didn't return this sync.
  // That's the most likely cause of "I edited the count but it didn't update"
  // — BG silently stops returning the commitment (status filter? expiry?).
  const missing = existing.filter(e => !seenCmIds.has(e.commitmentId));
  for (const m of missing) {
    console.log(`[bg/sync-commitments] ${m.commitmentId} MISSING from BG response (was count=${m.count}, status=${m.status})`);
  }

  const day = new Date().toISOString().slice(0, 10);
  for (const ch of priceChanges) {
    try {
      const results = await repriceCommitmentOrders(ch.id, ch.commitmentId, ch.to, day);
      if (worthTelling(results)) await notifyPriceChange(uid, ch.commitmentId, ch.from, ch.to, '', results, false);
    } catch (e) {
      console.error(`[bg/sync-commitments] ${ch.commitmentId} reprice failed:`, String(e).slice(0, 160));
    }
  }

  const tierShort = await checkTierPayouts(uid, syncedAt).catch(e => {
    console.error('[bg/sync-commitments] tier check failed:', String(e).slice(0, 160));
    return 0;
  });

  console.log(`[bg/sync-commitments] done: returned=${commitments.length} changed=${changed} missing=${missing.length} repriced=${priceChanges.length} tierShort=${tierShort}`);
  return Response.json({ synced: upserted, changed, missing: missing.length, repriced: priceChanges.length, tierShort });
}

// Tiered payouts: a commitment BG marked fulfilled inside a faster tier's deadline should carry that tier's
// commission within a day. If it still doesn't, tell the user once (lib/bgPayoutTiers.ts).
async function checkTierPayouts(uid: number, now: Date): Promise<number> {
  const rows = await prisma.buyingGroupCommitment.findMany({
    where: { userId: uid, tierShortAt: null, fulfilledAt: { not: null, lte: new Date(now.getTime() - TIER_GRACE_MS) } },
    select: { id: true, commitmentId: true, dealTitle: true, commission: true, fulfilled: true, fulfilledAt: true, raw: true },
  });
  const short = rows.flatMap(r => {
    const earned = underpaidTier(bgPayoutTiers(r.raw), r.commission, r.fulfilledAt!);
    return earned ? [{ r, earned }] : [];
  });
  if (short.length === 0) return 0;
  const [key, token] = await Promise.all([getSetting(uid, 'pushover_user_key'), getSetting(uid, 'pushover_app_token')]);
  for (const { r, earned } of short) {
    const text = tierShortText(r.dealTitle, r.commitmentId, r.commission, earned, r.fulfilled, r.fulfilledAt!);
    console.log(`[bg/sync-commitments] ${r.commitmentId} tier short: paid ${r.commission.toFixed(2)} earned ${earned.label} ${earned.commission.toFixed(2)}`);
    if (key?.value && token?.value) {
      await sendPushover(key.value, token.value, text, 'BuyingGroup paid the wrong tier')
        .catch(e => console.error('[bg/sync-commitments] tier pushover failed:', String(e).slice(0, 160)));
    }
    await prisma.buyingGroupCommitment.update({ where: { id: r.id }, data: { tierShortAt: now } });
  }
  return short.length;
}

function parseUsDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`);
}

function parseUsDateTime(s: string | null | undefined): Date | null {
  if (!s) return null;
  // "06-22-2026, 08:50:27"
  const m = s.match(/^(\d{2})-(\d{2})-(\d{4}),?\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return parseUsDate(s);
  const [, mm, dd, yyyy, h, min, sec] = m;
  return new Date(`${yyyy}-${mm}-${dd}T${h}:${min}:${sec}Z`);
}
