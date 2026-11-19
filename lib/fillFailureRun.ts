import { prisma, getSetting, upsertSetting } from '@/lib/db';
import { sendPushover } from '@/lib/pushover';
import type { GapOrder } from '@/lib/gapFill';
import { couldNotGet, planFillPush, rememberKeys, type FillFailure, type LinkFailure } from '@/lib/fillFailureAlert';
import type { MatchRunResult } from '@/lib/commitmentMatchRun';

// Sends the failure-only push (lib/fillFailureAlert.ts). The told-before keys
// live in a per-user setting so a restart never repeats a note. Logs counts
// only and never throws.
const ALERTED_KEY = 'fill_failure_alerted';
const PER_ORDER_TYPES = ['SYNC_WALMART_ORDER', 'SYNC_COSTCO_ORDER'];
const LOOKBACK_MS = 3 * 24 * 3600 * 1000;

async function told(userId: number): Promise<string[]> {
  try {
    const v = JSON.parse((await getSetting(userId, ALERTED_KEY))?.value ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

async function push(userId: number, failures: FillFailure[]): Promise<number> {
  if (!failures.length) return 0;
  const before = await told(userId);
  const plan = planFillPush(failures, new Set(before));
  if (!plan.text) return 0;
  const [key, token] = await Promise.all([getSetting(userId, 'pushover_user_key'), getSetting(userId, 'pushover_app_token')]);
  // Remember the issues even without Pushover set up, so they do not flood in the day it is.
  await upsertSetting(userId, ALERTED_KEY, JSON.stringify(rememberKeys(before, plan.keys)));
  if (!key?.value || !token?.value) return 0;
  await sendPushover(key.value, token.value, plan.text, 'Order fill').catch(e => console.error('[fill-failure] pushover failed:', String(e).slice(0, 160)));
  return plan.keys.length;
}

/** Orders a finished per-order fetch left unfilled. Run on the email import's schedule. */
export async function alertCouldNotGet(nowMs: number = Date.now()): Promise<number> {
  try {
    const cmds = await prisma.extensionCommand.findMany({
      where: { type: { in: PER_ORDER_TYPES }, status: { in: ['done', 'failed'] }, updatedAt: { gte: new Date(nowMs - LOOKBACK_MS) } },
      select: { status: true, payload: true },
    });
    const finished = cmds.map(c => {
      let orderNumbers: string[] = [];
      try { orderNumbers = (JSON.parse(c.payload ?? '{}').orderNumbers ?? []).map(String); } catch { /* no payload */ }
      return { status: c.status, orderNumbers };
    }).filter(c => c.orderNumbers.length);
    if (!finished.length) return 0;
    const wanted = new Set(finished.flatMap(c => c.orderNumbers));
    const rows = await prisma.order.findMany({
      where: { cancelled: false, orderNumber: { in: [...wanted] } },
      select: { userId: true, platform: true, orderNumber: true, itemDescription: true, shippingAddress: true, trackingNumbers: true, cardId: true },
    });
    let sent = 0;
    const byUser = new Map<number, GapOrder[]>();
    for (const r of rows) {
      if (r.userId == null) continue;
      byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), { ...r, platform: String(r.platform ?? ''), orderNumber: String(r.orderNumber ?? ''), shipped: false }]);
    }
    for (const [uid, orders] of byUser) sent += await push(uid, couldNotGet(finished, orders));
    console.log(`[fill-failure] could-not-get commands=${finished.length} told=${sent}`);
    return sent;
  } catch (e) {
    console.error('[fill-failure] could-not-get failed:', String(e).slice(0, 160));
    return 0;
  }
}

/** Orders the commitment match could not place. */
export async function alertCouldNotLink(userId: number | null, result: MatchRunResult): Promise<number> {
  try {
    const placed = result.unplaced.filter((u): u is typeof u & { reason: LinkFailure } => u.reason !== 'no-item');
    if (userId == null || !placed.length) return 0;
    const rows = await prisma.order.findMany({ where: { userId, id: { in: placed.map(u => u.orderId) } }, select: { id: true, orderNumber: true } });
    const num = new Map(rows.map(r => [r.id, r.orderNumber]));
    const failures: FillFailure[] = placed.flatMap(u => {
      const orderNumber = num.get(u.orderId);
      return orderNumber ? [{ kind: 'link' as const, orderNumber, reason: u.reason }] : [];
    });
    const sent = await push(userId, failures);
    console.log(`[fill-failure] could-not-link unplaced=${placed.length} told=${sent}`);
    return sent;
  } catch (e) {
    console.error('[fill-failure] could-not-link failed:', String(e).slice(0, 160));
    return 0;
  }
}
