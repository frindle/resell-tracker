import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getBgAccessToken } from '@/lib/bgAuth';
import { getCommitments } from '@/lib/buyinggroup';
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

// Sync the user's BuyingGroup commitments into our DB. Upserts by
// (userId, commitmentId). Called from the /buyinggroup/commitments page
// "Sync now" button AND auto-fired by the extension API Spy when it
// detects a successful edit_commitment on buyinggroup.com (#76).
export async function POST(req: NextRequest) {
  const sessionUid = await getSessionUserId();
  const headerUid = req.headers.get('X-Extension-User-Id');
  const parsed = headerUid ? parseInt(headerUid) : NaN;
  const uid = sessionUid ?? (Number.isFinite(parsed) ? parsed : null);
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });

  let token: string;
  try {
    token = await getBgAccessToken(uid);
  } catch (e) {
    return Response.json({ error: `BG auth failed: ${String(e)}` }, { status: 401 });
  }

  // Paginate through all commitments. BG's get_commitments takes page +
  // page_size; loop until we've fetched everything reported in count.
  let commitments: Awaited<ReturnType<typeof getCommitments>>['commitments'] = [];
  try {
    let page = 1;
    while (true) {
      const { commitments: batch, count } = await getCommitments(token, page, 100);
      commitments.push(...batch);
      if (commitments.length >= count || batch.length === 0) break;
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
    select: { commitmentId: true, count: true, fulfilled: true, status: true },
  });
  const existingByCmId = new Map(existing.map(e => [e.commitmentId, e]));
  const seenCmIds = new Set<string>();

  let upserted = 0;
  let changed = 0;
  for (const c of commitments) {
    // Parse "MM-DD-YYYY" → Date. BG uses US-style format.
    const expiryDay = parseUsDate(c.expiry_day);
    const createdDt = parseUsDateTime(c.created_dt);
    const price = parseFloat(c.price) || 0;
    const commission = parseFloat(c.commission) || 0;
    const total = parseFloat(c.total) || 0;

    seenCmIds.add(c.commitment_id);
    const prev = existingByCmId.get(c.commitment_id);
    if (prev) {
      const countDiff = prev.count !== c.count;
      const fulDiff = prev.fulfilled !== c.fulfilled;
      const statusDiff = prev.status !== (c.status ?? 'UNKNOWN');
      if (countDiff || fulDiff || statusDiff) {
        changed++;
        console.log(
          `[bg/sync-commitments] ${c.commitment_id} changed:` +
          (countDiff ? ` count ${prev.count}→${c.count}` : '') +
          (fulDiff ? ` fulfilled ${prev.fulfilled}→${c.fulfilled}` : '') +
          (statusDiff ? ` status ${prev.status}→${c.status ?? 'UNKNOWN'}` : '')
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
        lastSyncedAt: new Date(),
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

  console.log(`[bg/sync-commitments] done: returned=${commitments.length} changed=${changed} missing=${missing.length}`);
  return Response.json({ synced: upserted, changed, missing: missing.length });
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
