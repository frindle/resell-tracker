// Keeps Order.memberReward (the Costco Executive reward, lib/costcoReward.ts)
// in step with the order's money: on save, import, a return, and a change of
// the reward rate. A value the user typed on the order form is theirs and is
// left alone ('memberReward' in userEditedFields).
import { prisma, getSetting } from '@/lib/db';
import { COSTCO_REWARD_RATE_KEY, costcoReward, parseRewardRate } from '@/lib/costcoReward';
import { parseUserEditedFields } from '@/lib/orderFieldSync';

export async function rewardRate(userId: number | null): Promise<number> {
  return parseRewardRate((await getSetting(userId, COSTCO_REWARD_RATE_KEY))?.value);
}

const REWARD_SELECT = {
  id: true, userId: true, platform: true, cost: true, returnedCost: true,
  cancelled: true, memberReward: true, userEditedFields: true,
} as const;

type RewardRow = {
  id: number; userId: number | null; platform: string; cost: number; returnedCost: number;
  cancelled: boolean; memberReward: number | null; userEditedFields: string | null;
};

/** The reward the order should carry: the user's typed value if they typed one, else the computed one. */
async function apply(o: RewardRow, rate: number): Promise<number | null> {
  if (parseUserEditedFields(o.userEditedFields).includes('memberReward')) return o.memberReward;
  const want = costcoReward(o, rate);
  if (want !== o.memberReward) await prisma.order.updateMany({ where: { id: o.id }, data: { memberReward: want } });
  return want;
}

/** Recompute one order's reward; returns what it now holds (undefined when there is no such order). */
export async function syncMemberReward(orderId: number, rate?: number): Promise<number | null | undefined> {
  const o = await prisma.order.findUnique({ where: { id: orderId }, select: REWARD_SELECT });
  if (!o) return undefined;
  return apply(o, rate ?? (await rewardRate(o.userId)));
}

/** Recompute every order of the user's that is or was a Costco order (after the rate changes). */
export async function syncAllMemberRewards(userId: number | null): Promise<number> {
  const rate = await rewardRate(userId);
  const rows = await prisma.order.findMany({
    where: { userId, OR: [{ platform: { contains: 'costco' } }, { memberReward: { not: null } }] },
    select: REWARD_SELECT,
  });
  let changed = 0;
  for (const o of rows) if ((await apply(o, rate)) !== o.memberReward) changed++;
  return changed;
}
