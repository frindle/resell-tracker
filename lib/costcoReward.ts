// Costco Executive membership reward: a percentage (2% today) of what was paid
// for the merchandise on a Costco order, before sales tax and shipping. Costco
// pays it once a year as a reward certificate, so on an order it is a credit
// like card cashback, kept in its own field (Order.memberReward).
//
// The base is Order.merchandiseSubtotal when an importer read it: the
// order-details page's merchandise total less its discounts, or the order
// email's Subtotal less its Discount. Without it the base is an estimate,
// cost less the sales tax when that is known; Costco online orders keep
// cost = the order total, so an estimate made without the tax is a little high.
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
  taxAmount?: number | null;
  returnedCost?: number | null;
  merchandiseSubtotal?: number | null;
  cancelled?: boolean | null;
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * The dollars the reward is figured on, after returns. `exact` is true when the
 * merchandise subtotal was read from Costco; false for the cost-less-tax estimate.
 */
export function costcoRewardBase(o: RewardOrder): { base: number; exact: boolean } {
  const cost = num(o.cost);
  const known = typeof o.merchandiseSubtotal === 'number' && Number.isFinite(o.merchandiseSubtotal) && o.merchandiseSubtotal >= 0;
  const gross = known ? (o.merchandiseSubtotal as number) : Math.max(cost - num(o.taxAmount), 0);
  // Returned units: the kept share of what was paid. returnedCost is on the cost basis, so it is a fraction of cost.
  const returned = num(o.returnedCost);
  const kept = returned > 0 && cost > 0 ? Math.max(0, 1 - returned / cost) : 1;
  return { base: round2(gross * kept), exact: known };
}

/** The reward in dollars, or null when the order earns none (not Costco, cancelled, or the rate is off). */
export function costcoReward(o: RewardOrder, ratePct: number): number | null {
  if (!isCostco(o.platform) || o.cancelled || !(ratePct > 0)) return null;
  return round2((costcoRewardBase(o).base * ratePct) / 100);
}

/** A scraped subtotal: a finite, non-negative number, else null (unknown, never a guess). */
export function cleanSubtotal(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? round2(v) : null;
}
