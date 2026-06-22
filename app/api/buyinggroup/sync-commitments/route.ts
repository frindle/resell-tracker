import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getBgAccessToken } from '@/lib/bgAuth';
import { getCommitments } from '@/lib/buyinggroup';

export const dynamic = 'force-dynamic';

// Sync the user's BuyingGroup commitments into our DB. Upserts by
// (userId, commitmentId). Called from the /buyinggroup/commitments page
// "Sync now" button — no scheduled job yet.
export async function POST() {
  const uid = await getSessionUserId();
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

  let upserted = 0;
  for (const c of commitments) {
    // Parse "MM-DD-YYYY" → Date. BG uses US-style format.
    const expiryDay = parseUsDate(c.expiry_day);
    const createdDt = parseUsDateTime(c.created_dt);
    const price = parseFloat(c.price) || 0;
    const commission = parseFloat(c.commission) || 0;
    const total = parseFloat(c.total) || 0;

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

  return Response.json({ synced: upserted });
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
