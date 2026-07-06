import { prisma, getSetting, upsertSetting } from './db';
import { sendPushover } from './pushover';

// Daily Pushover digest of orders approaching (or past) their group
// delivery deadline that still haven't shipped. The Ships-By badge on
// /orders shows the same thing, but only when the page is open — this
// closes the loop when it isn't.
//
// "Still needs to ship" = has a deadline, no tracking yet, not paid,
// not lost. Near = due within NEAR_DAYS (matches the badge's red window).

const NEAR_DAYS = 3;
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

  const now = Date.now();
  const nearCutoff = now + NEAR_DAYS * 24 * 60 * 60 * 1000;
  const actionable = orders.filter(o => {
    const t = o.deliveryDeadline!.getTime();
    return t <= nearCutoff; // includes overdue
  });
  if (actionable.length === 0) return;

  // One digest per user per local day.
  const byUser = new Map<number | null, typeof actionable>();
  for (const o of actionable) {
    (byUser.get(o.userId) ?? byUser.set(o.userId, []).get(o.userId)!).push(o);
  }

  const today = localDateStr();
  for (const [userId, list] of byUser) {
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

      await sendPushover(
        userKey.value,
        appToken.value,
        lines.join('\n'),
        `Resell Tracker — ${overdue.length ? `${overdue.length} overdue, ` : ''}${near.length} due within ${NEAR_DAYS}d`,
      );
      await upsertSetting(userId, 'deadline_reminder_sent_on', today);
      console.log(`[deadline-reminder] sent digest to user ${userId}: ${overdue.length} overdue, ${near.length} near`);
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
