import { prisma } from '@/lib/db';
import { gated } from '@/lib/primaryFlag';
import { autoSubmitTrackingForOrders } from '@/lib/autoSubmitTracking';
import { sweepCandidateIds, SWEEP_DAYS } from '@/lib/autoSubmitSweepPlan';

// Every 15 minutes, push tracking for BuyingGroup / BigSky orders that have it locally but were
// never submitted (buyer assigned after the tracking arrived, or an earlier submit failed).
// Same submit path and rules as the upload-time auto-submit; see lib/autoSubmitSweepPlan.ts.

const EVERY_MS = 15 * 60 * 1000;
const BOOT_DELAY_MS = 2 * 60 * 1000;

export async function sweepUnsubmittedTracking(userId: number, nowMs = Date.now()): Promise<number> {
  const since = new Date(nowMs - SWEEP_DAYS * 86400000);
  const rows = await prisma.order.findMany({
    where: {
      userId, cancelled: false, locked: false, trackingSubmittedToBg: false,
      trackingNumbers: { not: null }, orderDate: { gte: since },
    },
    select: { id: true, orderDate: true, trackingNumbers: true, trackingSubmittedToBg: true, cancelled: true, locked: true, buyer: { select: { name: true } } },
  });
  const ids = sweepCandidateIds(rows.map(r => ({ ...r, buyerName: r.buyer?.name ?? null })), nowMs);
  if (ids.length) await autoSubmitTrackingForOrders(userId, ids, 'sweep');
  return ids.length;
}

async function runSweep(): Promise<void> {
  const users = await prisma.setting.findMany({
    where: { key: { in: ['bigsky_cookie', 'bg_email'] }, value: { not: '' } },
    select: { userId: true },
    distinct: ['userId'],
  });
  for (const u of users) {
    if (u.userId == null) continue;
    try {
      const n = await sweepUnsubmittedTracking(u.userId);
      if (n) console.log(`[bg-submit/sweep] user=${u.userId} candidates=${n}`);
    } catch (e) {
      console.warn('[bg-submit/sweep] failed:', String(e).slice(0, 160));
    }
  }
}

export function startAutoSubmitSweep(): void {
  const run = gated('tracking-submit-sweep', runSweep);
  setTimeout(run, BOOT_DELAY_MS);
  setInterval(run, EVERY_MS);
}
