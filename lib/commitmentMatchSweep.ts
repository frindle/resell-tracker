import { prisma } from '@/lib/db';
import { gated } from '@/lib/primaryFlag';
import { matchOrdersToCommitments } from '@/lib/commitmentMatchRun';
import { changedLines as changed } from '@/lib/commitmentMatchIds';

// Re-runs the commitment matcher over recent orders that still have no group link. An order is often
// imported before its reservation or commitment has synced, and the import-time run never looks again.
// Same rules as at import (exactly one candidate, never submits anything). It does not alert: the
// "could not link" alert belongs to the import. Logs one line per order, and only when that order's
// reason changed since the last sweep, so a stuck order does not repeat every hour.

const EVERY_MS = 60 * 60 * 1000;
const BOOT_DELAY_MS = 15 * 60 * 1000;
export const SWEEP_DAYS = 21;

const lastLine = new Map<string, string>(); // `${userId}:${orderId}` -> last logged reason

export async function sweepRecentOrders(userId: number, nowMs = Date.now()): Promise<{ checked: number; linked: number }> {
  const since = new Date(nowMs - SWEEP_DAYS * 86400000);
  const orders = await prisma.order.findMany({
    where: {
      userId, cancelled: false, locked: false, orderDate: { gte: since },
      bfmrLinks: { none: {} }, commitmentLinks: { none: {} }, bigSkyLinks: { none: {} },
    },
    select: { id: true },
  });
  if (!orders.length) return { checked: 0, linked: 0 };
  const r = await matchOrdersToCommitments(userId, orders.map(o => o.id), undefined, nowMs, undefined, false);
  for (const l of changed(userId, r.lines, lastLine)) console.log(`[commitment-sweep] ${l}`);
  return { checked: orders.length, linked: r.linked };
}

async function runSweep(): Promise<void> {
  const users = await prisma.setting.findMany({
    where: { key: { in: ['bfmr_api_key', 'bigsky_cookie', 'bg_email'] }, value: { not: '' } },
    select: { userId: true },
    distinct: ['userId'],
  });
  for (const u of users) {
    if (u.userId == null) continue;
    try {
      const r = await sweepRecentOrders(u.userId);
      if (r.linked) console.log(`[commitment-sweep] user=${u.userId} checked=${r.checked} linked=${r.linked}`);
    } catch (e) {
      console.warn('[commitment-sweep] failed:', String(e).slice(0, 160));
    }
  }
}

export function startCommitmentSweep(): void {
  const run = gated('commitment-sweep', runSweep);
  setTimeout(run, BOOT_DELAY_MS);
  setInterval(run, EVERY_MS);
}
