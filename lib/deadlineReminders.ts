import { prisma, getSetting, upsertSetting } from './db';
import { sendPushover } from './pushover';
import { OPEN_RETURN_STATUSES } from '@/lib/returnStatus';

// Daily Pushover digest of orders approaching (or past) their group
// delivery deadline that still haven't shipped. The Ships-By badge on
// /orders shows the same thing, but only when the page is open — this
// closes the loop when it isn't.
//
// "Still needs to ship" = has a deadline, no tracking yet, not paid,
// not lost. Near = due within NEAR_DAYS (matches the badge's red window).

const NEAR_DAYS = 3;
const STALE_RETURN_DAYS = 14; // return shipped this long ago with no refund → nag
const CHECK_MS = 6 * 60 * 60 * 1000; // evaluate 4×/day; sends at most once/day

function localDateStr(d: Date = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function runDeadlineCheck(): Promise<void> {
  let orders;
  try {
    orders = await prisma.order.findMany({
      where: {
        deliveryDeadline: { not: null },
        lost: false,
        salePriceSynced: false,
        OR: [{ trackingNumbers: null }, { trackingNumbers: '' }],
      },
      select: {
        userId: true, itemDescription: true, orderNumber: true,
        deliveryDeadline: true, platform: true,
      },
    });
  } catch (e) {
    console.error('[deadline-reminder] query failed:', e);
    return;
  }

  // Returns opened long ago that never reached a terminal state — money in
  // limbo. `requestedAt` is the OrderReturn's own clock (the retailer's return
  // date when we have it), which is as close as the per-item model gets to the
  // old whole-order returnShippedAt stamp.
  let staleReturns: Array<{ userId: number | null; itemDescription: string | null; orderNumber: string | null; platform: string; openedAt: Date | null }> = [];
  try {
    const rows = await prisma.orderReturn.findMany({
      where: {
        status: { in: [...OPEN_RETURN_STATUSES] },
        requestedAt: { lt: new Date(Date.now() - STALE_RETURN_DAYS * 24 * 60 * 60 * 1000) },
      },
      select: {
        requestedAt: true, itemName: true,
        order: { select: { userId: true, itemDescription: true, orderNumber: true, platform: true } },
      },
    });
    staleReturns = rows.map(r => ({
      userId: r.order.userId,
      itemDescription: r.itemName || r.order.itemDescription,
      orderNumber: r.order.orderNumber,
      platform: r.order.platform,
      openedAt: r.requestedAt,
    }));
  } catch (e) {
    console.error('[deadline-reminder] stale-return query failed:', e);
  }

  const now = Date.now();
  const nearCutoff = now + NEAR_DAYS * 24 * 60 * 60 * 1000;
  const actionable = orders.filter(o => {
    const t = o.deliveryDeadline!.getTime();
    return t <= nearCutoff; // includes overdue
  });
  if (actionable.length === 0 && staleReturns.length === 0) return;

  // One digest per user per local day.
  const byUser = new Map<number | null, typeof actionable>();
  for (const o of actionable) {
    (byUser.get(o.userId) ?? byUser.set(o.userId, []).get(o.userId)!).push(o);
  }
  const staleByUser = new Map<number | null, typeof staleReturns>();
  for (const o of staleReturns) {
    (staleByUser.get(o.userId) ?? staleByUser.set(o.userId, []).get(o.userId)!).push(o);
  }

  const today = localDateStr();
  const userIds = new Set([...byUser.keys(), ...staleByUser.keys()]);
  for (const userId of userIds) {
    const list = byUser.get(userId) ?? [];
    const stale = staleByUser.get(userId) ?? [];
    try {
      const lastSent = await getSetting(userId, 'deadline_reminder_sent_on');
      if (lastSent?.value === today) continue;

      const userKey = await getSetting(userId, 'pushover_user_key');
      const appToken = await getSetting(userId, 'pushover_app_token');
      if (!userKey?.value || !appToken?.value) continue;

      const overdue = list.filter(o => o.deliveryDeadline!.getTime() < now);
      const near = list.filter(o => o.deliveryDeadline!.getTime() >= now);
      const lines: string[] = [];
      for (const o of overdue.slice(0, 5)) {
        lines.push(`OVERDUE: ${(o.itemDescription ?? o.orderNumber ?? o.platform).slice(0, 60)} (was due ${localDateStr(o.deliveryDeadline!)})`);
      }
      for (const o of near.slice(0, 5)) {
        lines.push(`Due ${localDateStr(o.deliveryDeadline!)}: ${(o.itemDescription ?? o.orderNumber ?? o.platform).slice(0, 60)}`);
      }
      const more = list.length - Math.min(overdue.length, 5) - Math.min(near.length, 5);
      if (more > 0) lines.push(`…and ${more} more`);
      for (const o of stale.slice(0, 5)) {
        const days = o.openedAt ? Math.floor((now - o.openedAt.getTime()) / (24 * 60 * 60 * 1000)) : STALE_RETURN_DAYS;
        lines.push(`NO REFUND YET: ${(o.itemDescription ?? o.orderNumber ?? o.platform).slice(0, 60)} (return opened ${days}d ago)`);
      }
      if (stale.length > 5) lines.push(`…and ${stale.length - 5} more stale returns`);

      const titleParts: string[] = [];
      if (overdue.length) titleParts.push(`${overdue.length} overdue`);
      if (near.length) titleParts.push(`${near.length} due within ${NEAR_DAYS}d`);
      if (stale.length) titleParts.push(`${stale.length} refund(s) missing`);
      await sendPushover(
        userKey.value,
        appToken.value,
        lines.join('\n'),
        `Resell Tracker — ${titleParts.join(', ')}`,
      );
      await upsertSetting(userId, 'deadline_reminder_sent_on', today);
      console.log(`[deadline-reminder] sent digest to user ${userId}: ${overdue.length} overdue, ${near.length} near, ${stale.length} stale returns`);
    } catch (e) {
      console.error(`[deadline-reminder] user ${userId} failed:`, e);
    }
  }
}

export function startDeadlineReminders(): void {
  // Small delay so boot-time DB migrations settle first.
  setTimeout(runDeadlineCheck, 60 * 1000);
  setInterval(runDeadlineCheck, CHECK_MS);
}
