'use strict';
// Sales tax is kept apart from `cost` on import (Order.taxAmount / Order.subtotalAmount). `cost` keeps meaning what
// it always did (the scraped order total); this only adds the split when the source page showed a tax figure.
// subtotalAmount is the pre-tax total (cost - tax), so subtotal + tax is what the card was charged.

/** Set order.taxAmount and order.subtotalAmount from a scraped tax; no-ops (leaves both unset) when tax or cost is unusable. */
function applyTax(order, tax) {
  if (tax == null || !Number.isFinite(tax) || tax < 0) return order;
  const cost = order.cost;
  if (!Number.isFinite(cost) || cost <= 0 || tax > cost) return order;
  order.taxAmount = Math.round(tax * 100) / 100;
  order.subtotalAmount = Math.round((cost - tax) * 100) / 100;
  return order;
}

/** The same split as a plain object to spread into a new order row ({} when there is nothing usable). */
function taxFields(cost, tax) {
  const o = applyTax({ cost }, tax);
  return o.taxAmount === undefined ? {} : { taxAmount: o.taxAmount, subtotalAmount: o.subtotalAmount };
}

module.exports = { applyTax, taxFields };
