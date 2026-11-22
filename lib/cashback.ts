// Shared cashback formula — must match the client-side calc in components/OrderForm.tsx.
// excludeShipping: some card rates don't cover shipping. (The Costco Executive reward is its own field: lib/costcoReward.ts.)
// bonusPercent: extra rate stacked on top (e.g. Amazon's No-Rush delivery bonus).
export function computeCashback(cost: number, shippingCost: number, insuranceCost: number, rewardsRate: number, excludeShipping = false, bonusPercent = 0): number {
  const cb = ((cost + (excludeShipping ? 0 : shippingCost) + insuranceCost) * (rewardsRate + bonusPercent)) / 100;
  return Math.round(cb * 100) / 100;
}
