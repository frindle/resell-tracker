import { prisma, getSetting, upsertSetting } from '@/lib/db';
import { trackingUserId } from '@/lib/amazonTracking';
import { AMAZON_EXTENSION_TARGET } from '@/lib/amazonSync';
import {
  parseState, addVisits, pickAuto, pickClick, completeStage, needsListRead, markListRead, pauseAuto, resumeAuto,
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
  const state = await load(uid);
  const next = addVisits(state, adds, now);
  await save(uid, next);
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
  const state = await load(uid);
  if (state.pausedAt || !state.entries.some(e => e.stages.length)) return 0;
  if (await visitCommandInFlight(now)) return 0;
  const refreshed = await refresh(uid, state);
  const { visits, state: next } = pickAuto(refreshed, now);
  if (refreshed !== state || next !== refreshed) await save(uid, next);
  if (!visits.length) return 0;
  await prisma.extensionCommand.create({ data: { type: VISIT_AMAZON, targetBrowser: AMAZON_EXTENSION_TARGET, payload: JSON.stringify({ userId: uid, visits }) } });
  console.log(`[amazon-visits] queued run of ${visits.length} order(s) user=${uid}`);
  return visits.length;
}

/** "Sync Amazon" was clicked: resumes email-triggered visits and returns this run's pending visits. */
export async function pickClickVisits(uid: number, now = new Date()): Promise<{ visits: Visit[]; listDue: boolean }> {
  const state = resumeAuto(await refresh(uid, await load(uid)));
  const { visits, state: next } = pickClick(state, now);
  await save(uid, next);
  return { visits, listDue: needsListRead(next, now) };
}

/** An automatic run stopped at a sign-in, CAPTCHA or block page: no more until the next Sync click. */
export async function pauseAutoVisits(uid: number, now = new Date()): Promise<void> {
  await save(uid, pauseAuto(await load(uid), now));
}

export type CapturedVisit = { kind: 'orders' | 'detail' | 'tracking'; ok: boolean; orderNumber?: string; hasTracking?: boolean };

/** A page the tracker just read: finishes the stage it covered, or notes the list read. */
export async function recordCapturedPage(uid: number, c: CapturedVisit, now = new Date()): Promise<void> {
  if (!c.ok) return;
  const state = await load(uid);
  let next = state;
  if (c.kind === 'orders') next = markListRead(state, now);
  else if (c.orderNumber) {
    const stages: Stage[] = c.kind === 'detail' ? (c.hasTracking ? ['detail', 'track'] : ['detail']) : ['track'];
    next = completeStage(state, c.orderNumber, stages);
  }
  if (next !== state) await save(uid, next);
}
