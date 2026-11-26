import { prisma, getSetting, upsertSetting } from '@/lib/db';
import { trackingUserId } from '@/lib/amazonTracking';
import { AMAZON_EXTENSION_TARGET } from '@/lib/amazonSync';
import { withKeyedLock } from '@/lib/keyedLock';
import {
  parseState, addVisits, pickAuto, pickClick, completeStage, needsListRead, markListRead, pauseAuto, resumeAuto,
  markRead, settleAutoRun, chargeExtraLoads, plannedLoads, LIST_READ_IDLE_CLICK_MS,
  planAmazonVisit, type VisitState, type Visit, type Stage,
} from '@/lib/amazonVisitPlan';

// Database side of lib/amazonVisitPlan.ts. The pending list and the limits'
// bookkeeping live in one per-user Setting row (no table of their own).

export const VISIT_AMAZON = 'VISIT_AMAZON';
const KEY = 'amazon_visit_state';
/** A running visit command older than this is treated as dead. */
const RUNNING_STALE_MS = 30 * 60_000;
const digits = (s: string | null | undefined) => String(s ?? '').replace(/\D/g, '');

async function load(uid: number): Promise<VisitState> {
  return parseState((await getSetting(uid, KEY))?.value);
}
async function save(uid: number, s: VisitState): Promise<void> {
  await upsertSetting(uid, KEY, JSON.stringify(s));
}
/**
 * Every change is "load the row, modify, save the whole row". A page POST and a
 * command report often arrive together, so each change takes its turn here
 * and none overwrites another's.
 */
const locked = <T>(uid: number, work: () => Promise<T>) => withKeyedLock(`${KEY}:${uid}`, work);

export type EmailVisitHint = { order: string; kind: string; link?: string | null };

/**
 * An imported ORDER or SHIPPED email: compare it with the row it produced and
 * queue the visit it still needs. Null when this user's Amazon account is not
 * the one the browser is signed in to.
 */
export async function queueEmailVisits(uid: number, hints: readonly EmailVisitHint[], now = new Date()): Promise<{ queued: number } | null> {
  if (uid !== trackingUserId()) return null;
  if (!hints.length) return { queued: 0 };
  const rows = await prisma.order.findMany({
    where: { userId: uid, platform: 'Amazon', orderNumber: { in: [...new Set(hints.map(h => h.order))] } },
    select: { orderNumber: true, cardId: true, shippingAddress: true, cost: true, itemDescription: true, trackingNumbers: true, cancelled: true },
  });
  const byNum = new Map(rows.map(r => [digits(r.orderNumber), r]));
  const adds: { order: string; url?: string | null; stages: Stage[] }[] = [];
  for (const h of hints) {
    const row = byNum.get(digits(h.order));
    if (!row) continue;
    const d = planAmazonVisit(h.kind, row);
    if (d.stages.length) adds.push({ order: h.order, url: h.link, stages: d.stages });
  }
  if (!adds.length) return { queued: 0 };
  await locked(uid, async () => save(uid, addVisits(await load(uid), adds, now)));
  console.log(`[amazon-visits] queued ${adds.length} order visit(s) user=${uid}`);
  return { queued: adds.length };
}

/** Finishes stages the tracker no longer needs (order cancelled or gone, tracking arrived since). */
async function refresh(uid: number, state: VisitState): Promise<VisitState> {
  const open = state.entries.filter(e => e.stages.length);
  if (!open.length) return state;
  const rows = await prisma.order.findMany({
    where: { userId: uid, platform: 'Amazon', orderNumber: { in: open.map(e => e.order) } },
    select: { orderNumber: true, cancelled: true, trackingNumbers: true },
  });
  const byNum = new Map(rows.map(r => [digits(r.orderNumber), r]));
  let s = state;
  for (const e of open) {
    const row = byNum.get(digits(e.order));
    if (!row || row.cancelled) s = completeStage(s, e.order, ['detail', 'track']);
    else if (String(row.trackingNumbers ?? '').trim()) s = completeStage(s, e.order, ['track']);
  }
  return s;
}

async function visitCommandInFlight(now: Date): Promise<boolean> {
  const n = await prisma.extensionCommand.count({
    where: {
      type: { in: [VISIT_AMAZON, 'SYNC_AMAZON_PAGES', 'TRACK_AMAZON'] },
      OR: [{ status: 'pending' }, { status: 'running', updatedAt: { gte: new Date(now.getTime() - RUNNING_STALE_MS) } }],
    },
  });
  return n > 0;
}

/**
 * Called when the extension polls for commands: when an email's random delay
 * has passed, hands it a VISIT_AMAZON command (a few orders, within the day's
 * budget). Nothing while paused, while another Amazon command is waiting or
 * running, or when nothing is due.
 */
export async function materializeAutoVisits(now = new Date()): Promise<number> {
  const uid = trackingUserId();
  return locked(uid, async () => {
    const state = await load(uid);
    if (state.pausedAt || !state.entries.some(e => e.stages.length)) return 0;
    if (await visitCommandInFlight(now)) return 0;
    const refreshed = await refresh(uid, state);
    const { visits, state: next } = pickAuto(refreshed, now);
    // The command first: if it cannot be created, the orders keep their try.
    if (visits.length) {
      await prisma.extensionCommand.create({ data: { type: VISIT_AMAZON, targetBrowser: AMAZON_EXTENSION_TARGET, payload: JSON.stringify({ userId: uid, visits }) } });
    }
    if (refreshed !== state || next !== refreshed) await save(uid, next);
    if (visits.length) console.log(`[amazon-visits] queued run of ${visits.length} order(s) user=${uid}`);
    return visits.length;
  });
}

/** "Sync Amazon" was clicked: resumes email-triggered visits and returns this run's pending visits. */
export async function pickClickVisits(uid: number, now = new Date()): Promise<{ visits: Visit[]; listDue: boolean }> {
  return locked(uid, async () => {
    const state = resumeAuto(await refresh(uid, await load(uid)));
    const { visits, state: next } = pickClick(state, now);
    await save(uid, next);
    // With no order to visit, a click reads the order list (unless it was read in the last hour),
    // so a click is never a run that opens nothing while orders may be missing.
    const listDue = needsListRead(next, now) || (!visits.length && needsListRead(next, now, LIST_READ_IDLE_CLICK_MS));
    return { visits, listDue };
  });
}

/**
 * An automatic run ended (the extension reported its command done or failed).
 * Orders it was sent to whose pages the tracker did not read since the command
 * was queued go back in line after a short wait.
 *
 * opts.refund: the run never reached its orders (another run was going, or a
 * block page stopped it), so they get their try back. opts.pages: the pages
 * the run really opened; any beyond what it was charged come off today's budget.
 */
export async function settleAutoVisits(
  uid: number,
  visits: readonly { orderNumber: string; stages?: readonly Stage[] }[],
  since: Date,
  opts: { refund?: boolean; pages?: number } = {},
  now = new Date(),
): Promise<number> {
  const orders = visits.map(v => v.orderNumber);
  return locked(uid, async () => {
    const state = await load(uid);
    const settled = settleAutoRun(state, orders, since, now, !!opts.refund);
    const extra = (opts.pages ?? 0) - plannedLoads(visits.map(v => ({ stages: v.stages ?? [] })));
    const next = chargeExtraLoads(settled, extra, now);
    if (next === state) return 0;
    await save(uid, next);
    const unread = settled.entries.filter((e, i) => e !== state.entries[i]).length;
    if (unread) console.log(`[amazon-visits] run ended with ${unread} of ${orders.length} order(s) unread; back in line${opts.refund ? ' (try refunded)' : ''} user=${uid}`);
    return unread;
  });
}

/** An automatic run stopped at a sign-in, CAPTCHA or block page: no more until the next Sync click. */
export async function pauseAutoVisits(uid: number, now = new Date()): Promise<void> {
  await locked(uid, async () => save(uid, pauseAuto(await load(uid), now)));
}

export type CapturedVisit = { kind: 'orders' | 'detail' | 'tracking'; ok: boolean; orderNumber?: string; hasTracking?: boolean; /** False when the tracker is in compare mode (nothing was written). */ applied?: boolean };

/** A page the tracker just read: finishes the stage it covered, or notes the list read. */
export async function recordCapturedPage(uid: number, c: CapturedVisit, now = new Date()): Promise<void> {
  if (!c.ok) return;
  await locked(uid, async () => {
    const state = await load(uid);
    let next = state;
    if (c.kind === 'orders') next = markListRead(state, now);
    else if (c.orderNumber) {
      // In compare mode a detail page fills nothing, so its stage stays pending
      // (a later Sync click reads it again once apply is on).
      const detail: Stage[] = c.applied === false ? [] : ['detail'];
      const stages: Stage[] = c.kind === 'detail' ? [...detail, ...(c.hasTracking ? ['track' as Stage] : [])] : ['track'];
      // The read is noted even when it finishes nothing: that is what tells a
      // run that worked from one whose pages never arrived.
      next = markRead(stages.length ? completeStage(state, c.orderNumber, stages) : state, c.orderNumber, now);
    }
    if (next !== state) await save(uid, next);
  });
}
