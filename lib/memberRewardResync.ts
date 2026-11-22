// One pass after the deploy that moved the Costco Executive reward's base to the
// purchase price (lib/costcoReward.ts, 2026-11-22): every Costco order, locked
// ones included, is re-figured at the user's rate. A reward the user typed
// stays (lib/memberRewardSync.ts). Once per user (Setting costco_reward_basis_v2).
// Logs counts only.
import { prisma, getSetting, upsertSetting } from '@/lib/db';
import { gated } from '@/lib/primaryFlag';
import { syncAllMemberRewards } from '@/lib/memberRewardSync';

const DONE_KEY = 'costco_reward_basis_v2';
const BOOT_DELAY_MS = 2 * 60 * 1000;

export async function runMemberRewardResync(): Promise<void> {
  try {
    const users = await prisma.order.findMany({
      where: { OR: [{ platform: { contains: 'costco' } }, { memberReward: { not: null } }] },
      distinct: ['userId'], select: { userId: true },
    });
    for (const { userId } of users) {
      if ((await getSetting(userId, DONE_KEY))?.value) continue;
      const changed = await syncAllMemberRewards(userId);
      await upsertSetting(userId, DONE_KEY, new Date().toISOString());
      console.log(`[costco-reward] purchase-price basis: ${changed} order(s) re-figured`);
    }
  } catch (e) {
    console.error('[costco-reward] re-figure failed:', String(e).slice(0, 160));
  }
}

export function startMemberRewardResync(): void {
  const run = gated('costco-reward-resync', runMemberRewardResync);
  setTimeout(() => { void run(); }, BOOT_DELAY_MS);
}
