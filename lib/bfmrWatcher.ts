import { prisma, getSetting } from './db';
import { checkAndReserve } from './bfmrWeb';
import { sendPushover } from './pushover';

const POLL_MS = 2 * 60 * 1000; // 2 minutes

async function runCycle() {
  let watchers;
  try {
    watchers = await prisma.bfmrWatcher.findMany({ where: { active: true } });
  } catch {
    return;
  }

  for (const w of watchers) {
    try {
      const emailRow = await getSetting(w.userId, 'bfmr_email');
      const passwordRow = await getSetting(w.userId, 'bfmr_password');
      if (!emailRow?.value || !passwordRow?.value) {
        await prisma.bfmrWatcher.update({ where: { id: w.id }, data: { lastChecked: new Date(), lastResult: 'Missing BFMR credentials in Settings' } });
        continue;
      }

      const result = await checkAndReserve(emailRow.value, passwordRow.value, w.dealSlug, w.itemId, w.qty);

      if (result.reserved) {
        await prisma.bfmrWatcher.update({
          where: { id: w.id },
          data: { active: false, reservedAt: new Date(), lastChecked: new Date(), lastResult: `Reserved ${result.qtyReserved}` },
        });

        const userKeyRow = await getSetting(w.userId, 'pushover_user_key');
        const appTokenRow = await getSetting(w.userId, 'pushover_app_token');
        if (userKeyRow?.value && appTokenRow?.value) {
          await sendPushover(
            userKeyRow.value,
            appTokenRow.value,
            `Got ${result.qtyReserved}x ${w.itemName ?? w.dealTitle ?? w.dealSlug}`,
            'BFMR: Reservation Secured',
          ).catch(() => {});
        }
      } else {
        await prisma.bfmrWatcher.update({
          where: { id: w.id },
          data: { lastChecked: new Date(), lastResult: 'No slots available' },
        });
      }
    } catch (e) {
      await prisma.bfmrWatcher.update({
        where: { id: w.id },
        data: { lastChecked: new Date(), lastResult: `Error: ${String(e).slice(0, 200)}` },
      }).catch(() => {});
    }
  }
}

export function startWatcher() {
  runCycle();
  setInterval(runCycle, POLL_MS);
}
