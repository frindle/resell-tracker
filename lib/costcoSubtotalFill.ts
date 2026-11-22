// Queues the sidecar's Costco order-page read for orders with no merchandise
// subtotal yet (lib/costcoSubtotalPlan.ts), locked ones included, so their
// Costco Executive reward is figured on the real subtotal instead of the
// cost-less-tax estimate. Only while the sidecar's Costco session is active:
// without one every command would fail into the error digest.
//
// Runs once per user after a deploy (Setting costco_subtotal_fill_v1), and on
// demand from Settings. Logs counts only.
import { prisma, getSetting, upsertSetting } from '@/lib/db';
import { gated } from '@/lib/primaryFlag';
import { kickSidecarPoll } from '@/lib/sidecarKick';
import { isSubtotalPayload, payloadOrderNumbers, subtotalOrderNumbers, subtotalPayloads } from '@/lib/costcoSubtotalPlan';

export type SubtotalFillResult = { missing: number; queued: number; commands: number; session: string };

const DONE_KEY = 'costco_subtotal_fill_v1';
const BOOT_DELAY_MS = 10 * 60 * 1000;
const RETRY_MS = 6 * 60 * 60 * 1000;

const MISSING_WHERE = { platform: { contains: 'costco' }, cancelled: false, merchandiseSubtotal: null, orderNumber: { not: null } };

export async function queueCostcoSubtotalFill(uid: number): Promise<SubtotalFillResult> {
  const session = (await getSetting(uid, 'costco_session_status'))?.value ?? 'unset';
  const [rows, open] = await Promise.all([
    prisma.order.findMany({ where: { userId: uid, ...MISSING_WHERE }, select: { platform: true, orderNumber: true, cancelled: true, merchandiseSubtotal: true } }),
    prisma.extensionCommand.findMany({ where: { type: 'SYNC_COSTCO_ORDER', status: { in: ['pending', 'running'] } }, select: { payload: true } }),
  ]);
  const waiting = open.filter(c => isSubtotalPayload(c.payload)).flatMap(c => payloadOrderNumbers(c.payload));
  const missing = subtotalOrderNumbers(rows).length;
  const todo = subtotalOrderNumbers(rows, waiting);
  if (session !== 'active' || !todo.length) return { missing, queued: 0, commands: 0, session };
  const payloads = subtotalPayloads(todo, uid);
  for (const p of payloads) {
    await prisma.extensionCommand.create({ data: { type: 'SYNC_COSTCO_ORDER', targetBrowser: 'sidecar', payload: JSON.stringify(p) } });
  }
  kickSidecarPoll();
  return { missing, queued: todo.length, commands: payloads.length, session };
}

/** The once-per-user pass: done when the session was active (queued, or nothing was missing). */
export async function runCostcoSubtotalBackfill(): Promise<void> {
  try {
    const users = await prisma.order.findMany({ where: { ...MISSING_WHERE, userId: { not: null } }, distinct: ['userId'], select: { userId: true } });
    for (const { userId } of users) {
      if (userId == null || (await getSetting(userId, DONE_KEY))?.value) continue;
      const r = await queueCostcoSubtotalFill(userId);
      console.log(`[costco-subtotal] backfill missing=${r.missing} queued=${r.queued} commands=${r.commands} session=${r.session}`);
      if (r.session === 'active') await upsertSetting(userId, DONE_KEY, new Date().toISOString());
    }
  } catch (e) {
    console.error('[costco-subtotal] backfill failed:', String(e).slice(0, 160));
  }
}

export function startCostcoSubtotalBackfill(): void {
  const run = gated('costco-subtotal-backfill', runCostcoSubtotalBackfill);
  setTimeout(() => { void run(); }, BOOT_DELAY_MS);
  setInterval(() => { void run(); }, RETRY_MS);
}
