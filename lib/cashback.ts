// Shared cashback formula — must match the client-side calc in components/OrderForm.tsx.
export function computeCashback(cost: number, shippingCost: number, insuranceCost: number, rewardsRate: number): number {
  const cb = ((cost + shippingCost + insuranceCost) * rewardsRate) / 100;
  return Math.round(cb * 100) / 100;
}
