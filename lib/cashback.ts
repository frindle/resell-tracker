// Shared cashback formula — must match the client-side calc in components/OrderForm.tsx.
// excludeShipping: some rebates (e.g. Costco Executive's 2%) don't cover shipping.
export function computeCashback(cost: number, shippingCost: number, insuranceCost: number, rewardsRate: number, excludeShipping = false): number {
  const cb = ((cost + (excludeShipping ? 0 : shippingCost) + insuranceCost) * rewardsRate) / 100;
  return Math.round(cb * 100) / 100;
}
