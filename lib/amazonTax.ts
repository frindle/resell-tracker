// Mirrors sidecar/src/orderTax.js. Sales tax is kept apart from `cost`
// (the scraped order total); subtotal is the pre-tax total (cost - tax).
// null means "the page did not show a tax figure", never 0.
export function taxFields(cost: number, tax: number | null | undefined): { taxAmount?: number; subtotalAmount?: number } {
  if (tax == null || !Number.isFinite(tax) || tax < 0) return {};
  if (!Number.isFinite(cost) || cost <= 0 || tax > cost) return {};
  return { taxAmount: Math.round(tax * 100) / 100, subtotalAmount: Math.round((cost - tax) * 100) / 100 };
}
