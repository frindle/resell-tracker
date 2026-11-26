import { prisma, getSetting, upsertSetting } from '@/lib/db';
import { AMAZON_EXTENSION_TARGET } from '@/lib/amazonSync';
import { commandTarget } from '@/lib/commandWorker';
import { withKeyedLock } from '@/lib/keyedLock';
import {
  COSTCO_AUTO_HOURS_KEY, COSTCO_AUTO_STATE_KEY, sanitizeHours, parseState, planCostcoAutoSync, EMPTY_STATE,
  type AutoPlan, type CostcoRow,
} from '@/lib/costcoAutoSync';

// Database side of lib/costcoAutoSync.ts. The only thing kept between polls is
// the chosen random moment, in one per-user Setting row.

const COSTCO_TYPES = ['SYNC_COSTCO', 'SYNC_COSTCO_ORDER'];

async function recentRows(): Promise<CostcoRow[]> {
  const rows = await prisma.extensionCommand.findMany({
    // Only rows the extension can claim; a row aimed elsewhere would block the sync for good.
    where: { type: { in: COSTCO_TYPES }, targetBrowser: AMAZON_EXTENSION_TARGET, OR: [{ status: 'pending' }, { status: 'running' }] },
    select: { type: true, status: true, result: true, updatedAt: true },
  });
  const last = await prisma.extensionCommand.findFirst({
    where: { type: 'SYNC_COSTCO', status: { in: ['done', 'failed'] } },
    orderBy: { updatedAt: 'desc' },
    select: { type: true, status: true, result: true, updatedAt: true },
  });
  return [...rows, ...(last ? [last] : [])].map(r => ({ ...r, updatedAt: r.updatedAt.getTime() }));
}

/**
 * What the Settings page shows: the planner's answer from the same rows and
 * settings that drive queueing. Changes nothing.
 */
export async function costcoAutoSyncStatus(uid: number, now = new Date()): Promise<AutoPlan> {
  const hours = sanitizeHours((await getSetting(uid, COSTCO_AUTO_HOURS_KEY))?.value);
  const state = parseState((await getSetting(uid, COSTCO_AUTO_STATE_KEY))?.value);
  const rows = hours > 0 ? await recentRows() : [];
  return planCostcoAutoSync({ now: now.getTime(), hours, rows, state, rand: () => 0 });
}

/**
 * Called when the extension polls for commands: queues a SYNC_COSTCO for it
 * when one is due. Returns the planner's answer (`queue` is true when it
 * queued one). `uid` is the user whose Settings page holds the interval: the
 * one the extension polls as.
 */
export async function materializeCostcoAutoSync(uid: number, now = new Date()): Promise<AutoPlan> {
  return withKeyedLock(`${COSTCO_AUTO_STATE_KEY}:${uid}`, async () => {
    const hours = sanitizeHours((await getSetting(uid, COSTCO_AUTO_HOURS_KEY))?.value);
    if (hours <= 0) return planCostcoAutoSync({ now: now.getTime(), hours, rows: [], state: EMPTY_STATE });
    const state = parseState((await getSetting(uid, COSTCO_AUTO_STATE_KEY))?.value);
    const plan = planCostcoAutoSync({ now: now.getTime(), hours, rows: await recentRows(), state });
    // The command first: if it cannot be created, the chosen moment is kept and tried again.
    if (plan.queue) {
      await prisma.extensionCommand.create({
        data: { type: 'SYNC_COSTCO', targetBrowser: commandTarget('SYNC_COSTCO'), payload: JSON.stringify({ userId: uid, auto: true }) },
      });
      console.log(`[costco-auto-sync] queued user=${uid}`);
    }
    if (plan.state.dueAt !== state.dueAt || plan.state.basis !== state.basis) {
      await upsertSetting(uid, COSTCO_AUTO_STATE_KEY, JSON.stringify(plan.state));
    }
    return plan;
  });
}
