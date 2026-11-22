// Costco Executive membership reward: a percentage (2% today) of what was paid
// on a Costco order. Costco pays it once a year as a reward certificate, so on
// an order it is a credit like card cashback, kept in its own field
// (Order.memberReward).
//
// The base is the order's purchase price in the tracker (Order.cost), chosen
// 2026-11-22 over a subtotal read from Costco. Costco figures
// the real reward on the merchandise before tax and shipping, so on an order
// whose purchase price includes tax the figure is a little high.
//
// Returned units come off the base the way card cashback does (lib/cashback.ts
// callers net out returnedCost): Costco takes the reward back on a return.

export const COSTCO_REWARD_DEFAULT_RATE = 2;
/** Per-user Setting key holding the reward percent. "0" turns the reward off. */
export const COSTCO_REWARD_RATE_KEY = 'costco_executive_rate';

export function isCostco(platform: string | null | undefined): boolean {
  return (platform ?? '').trim().toLowerCase() === 'costco';
}

/** The stored setting as a percent: unset or unreadable = the default, never negative. */
export function parseRewardRate(value: string | null | undefined): number {
  if (value == null || value.trim() === '') return COSTCO_REWARD_DEFAULT_RATE;
  const n = Number(value.trim().replace(/%$/, ''));
  if (!Number.isFinite(n)) return COSTCO_REWARD_DEFAULT_RATE;
  return Math.min(Math.max(n, 0), 100);
}

export type RewardOrder = {
  platform: string | null | undefined;
  cost: number | null | undefined;
  returnedCost?: number | null;
  cancelled?: boolean | null;
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The dollars the reward is figured on: the purchase price, less returned units. */
export function costcoRewardBase(o: RewardOrder): number {
  const kept = num(o.cost) - num(o.returnedCost);
  return round2(Math.max(kept, 0));
}

/** The reward in dollars, or null when the order earns none (not Costco, cancelled, or the rate is off). */
export function costcoReward(o: RewardOrder, ratePct: number): number | null {
  if (!isCostco(o.platform) || o.cancelled || !(ratePct > 0)) return null;
  return round2((costcoRewardBase(o) * ratePct) / 100);
}

/** A scraped subtotal: a finite, non-negative number, else null (unknown, never a guess). */
export function cleanSubtotal(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? round2(v) : null;
}
