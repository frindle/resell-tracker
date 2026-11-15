import { prisma, getSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { resolveExtensionUserId } from '@/lib/extensionAuth';
import { fetchUserFulfillment, fetchScanItems } from '@/lib/bigsky';
import { parseFulfillmentRows, attachScanTracking } from '@/lib/bigskyCommitments';
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

// Read-only copy of the user's BigSky commitments, each fulfillment tied to
// the tracking number of the scan that filled it. Upsert by commitmentId;
// nothing is deleted, so a commitment BigSky stops returning keeps its last
// snapshot. Writes nothing to orders.
export async function POST(req: NextRequest) {
  try {
    const uid = resolveExtensionUserId(req, await getSessionUserId());
    if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });

    const cookie = (await getSetting(uid, 'bigsky_cookie'))?.value?.trim();
    if (!cookie) return Response.json({ error: 'BigSky is not connected (Settings › BigSky)' }, { status: 400 });

    // Both calls must succeed: without the scans every stored fulfillment
    // would lose its tracking numbers on this pass.
    const [raw, scans] = await Promise.all([fetchUserFulfillment(cookie, uid), fetchScanItems(cookie, uid)]);
    const { rows: parsed, skipped } = parseFulfillmentRows(raw);
    const rows = attachScanTracking(parsed, scans);

    const stored = await prisma.bigSkyCommitment.count({ where: { userId: uid } });
    if (rows.length === 0 && stored > 0) {
      const error = `BigSky returned ${raw.length} commitments (${skipped} unreadable) but ${stored} are stored; refusing to treat as a successful sync`;
      console.log(`[bigsky/sync-commitments] ${error}`);
      return Response.json({ error }, { status: 502 });
    }

    const now = new Date();
    let withTracking = 0, withoutTracking = 0;
    for (const r of rows) {
      for (const f of r.fulfillments) {
        if (f.trackingNumbers.length > 0) withTracking++; else withoutTracking++;
      }
      const data = {
        dealId: r.dealId,
        itemName: r.itemName,
        itemUpc: r.itemUpc,
        dealPrice: r.dealPrice,
        commitmentAmount: r.commitmentAmount,
        fulfilled: r.fulfilled,
        commitmentsRemaining: r.commitmentsRemaining,
        status: r.status,
        dealCreated: r.dealCreated,
        dealExpiration: r.dealExpiration,
        creationDate: r.creationDate,
        fulfillmentDate: r.fulfillmentDate,
        fulfillments: JSON.stringify(r.fulfillments),
        raw: JSON.stringify(r.raw),
        lastSyncedAt: now,
      };
      await prisma.bigSkyCommitment.upsert({
        where: { userId_commitmentId: { userId: uid, commitmentId: r.commitmentId } },
        create: { userId: uid, commitmentId: r.commitmentId, ...data },
        update: data,
      });
    }

    if (skipped > 0) console.warn(`[bigsky/sync-commitments] uid=${uid} skipped ${skipped} unreadable rows`);
    return Response.json({ synced: rows.length, skipped, fulfillmentsWithTracking: withTracking, fulfillmentsWithoutTracking: withoutTracking });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
