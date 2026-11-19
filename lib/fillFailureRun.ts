import { prisma, getSetting, upsertSetting } from '@/lib/db';
import { sendPushover } from '@/lib/pushover';
import type { FillFailure } from '@/lib/fillFailureAlert';
import { pushFailures, failuresByUser, linkFailures, type FillStore } from '@/lib/fillFailureCore';
import type { MatchRunResult } from '@/lib/commitmentMatchRun';

// Sends the failure-only push (lib/fillFailureAlert.ts). The told-before keys
// live in a per-user setting so a restart never repeats a note. Logs counts
// only and never throws.
const ALERTED_KEY = 'fill_failure_alerted';
const PER_ORDER_TYPES = ['SYNC_WALMART_ORDER', 'SYNC_COSTCO_ORDER'];
const LOOKBACK_MS = 3 * 24 * 3600 * 1000;

const store: FillStore = {
  async getTold(userId) {
    try {
      const v = JSON.parse((await getSetting(userId, ALERTED_KEY))?.value ?? '[]');
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  },
  async saveTold(userId, keys) { await upsertSetting(userId, ALERTED_KEY, JSON.stringify(keys)); },
  async getPushover(userId) {
    const [key, token] = await Promise.all([getSetting(userId, 'pushover_user_key'), getSetting(userId, 'pushover_app_token')]);
    return key?.value && token?.value ? { key: key.value, token: token.value } : null;
  },
  async send(creds, text) { await sendPushover(creds.key, creds.token, text, 'Order fill'); },
};

/** Orders a finished per-order fetch left unfilled. Run on the email import's schedule. */
export async function alertCouldNotGet(nowMs: number = Date.now()): Promise<number> {
  try {
    const cmds = await prisma.extensionCommand.findMany({
      where: { type: { in: PER_ORDER_TYPES }, status: { in: ['done', 'failed'] }, updatedAt: { gte: new Date(nowMs - LOOKBACK_MS) } },
      select: { status: true, payload: true },
    });
    const finished = cmds.map(c => {
      let orderNumbers: string[] = [];
      let userId: number | null = null;
      try {
        const p = JSON.parse(c.payload ?? '{}');
        orderNumbers = (p.orderNumbers ?? []).map(String);
        userId = Number.isInteger(p.userId) ? p.userId : null;
      } catch { /* no payload */ }
      return { status: c.status, orderNumbers, userId };
    }).filter(c => c.orderNumbers.length);
    if (!finished.length) return 0;
    const wanted = new Set(finished.flatMap(c => c.orderNumbers));
    const rows = await prisma.order.findMany({
      // A locked order is the person's to leave alone; it is never a failure.
      where: { cancelled: false, locked: false, orderNumber: { in: [...wanted] } },
      select: { userId: true, platform: true, orderNumber: true, itemDescription: true, shippingAddress: true, trackingNumbers: true, cardId: true },
    });
    const orders = rows.map(r => ({ ...r, platform: String(r.platform ?? ''), orderNumber: String(r.orderNumber ?? ''), shipped: false }));
    let sent = 0;
    for (const [uid, failures] of failuresByUser(finished, orders)) sent += await pushFailures(store, uid, failures);
    console.log(`[fill-failure] could-not-get commands=${finished.length} told=${sent}`);
    return sent;
  } catch (e) {
    console.error('[fill-failure] could-not-get failed:', String(e).slice(0, 160));
    return 0;
  }
}

/** Orders the commitment match could not place and the person has to decide. */
export async function alertCouldNotLink(userId: number | null, result: MatchRunResult): Promise<number> {
  try {
    if (userId == null || !result.unplaced.length) return 0;
    const rows = await prisma.order.findMany({ where: { userId, locked: false, id: { in: result.unplaced.map(u => u.orderId) } }, select: { id: true, orderNumber: true } });
    const failures: FillFailure[] = linkFailures(result.unplaced, new Map(rows.map(r => [r.id, r.orderNumber])));
    const sent = await pushFailures(store, userId, failures);
    console.log(`[fill-failure] could-not-link unplaced=${result.unplaced.length} told=${sent}`);
    return sent;
  } catch (e) {
    console.error('[fill-failure] could-not-link failed:', String(e).slice(0, 160));
    return 0;
  }
}
