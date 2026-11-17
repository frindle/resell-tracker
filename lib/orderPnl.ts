// The one place an order's profit is worked out. Analytics totals (calcStats),
// the home page, the orders list and the order form preview all call this, so
// they can't drift apart again (each used to do its own arithmetic, and only
// calcStats knew about partly sent gift card orders).
//
//   cost    = cost + shipping + insurance - returnedCost   (returned units are out of salePrice too)
//   credits = cashback + portal cashback + Amex offer dollars
//   profit  = sale - share × (cost - credits)
//
// share is the part of a gift card order sent to Card Center, by face value
// (lib/giftCardShare.ts). salePrice only covers the sent cards; the rest is
// still inventory. Orders without gift cards have share 1.
import { submittedShare, type CardForShare } from './giftCardShare.ts';

export type OrderMoney = {
  salePrice: number | null;
  cost: number;
  shippingCost: number;
  insuranceCost?: number | null;
  returnedCost?: number | null;
  cashbackAmount: number;
  portalCashback?: number | null;
  amexOfferDollars?: number | null;
  giftCards?: readonly CardForShare[] | null;
};

export type OrderPnl = {
  /** Sold share of the order, 0..1. */
  share: number;
  sale: number;
  /** Cost after returns, scaled to the share. */
  cost: number;
  /** Cashback, portal and Amex dollars, scaled to the share. */
  credits: number;
  /** cost - credits: the effective cost of what was sold. */
  effCost: number;
  profit: number;
};

export function orderPnl(o: OrderMoney): OrderPnl {
  const share = submittedShare(o.giftCards);
  const sale = o.salePrice ?? 0;
  const cost = (o.cost + o.shippingCost + (o.insuranceCost ?? 0) - (o.returnedCost ?? 0)) * share;
  const credits = (o.cashbackAmount + (o.portalCashback ?? 0) + (o.amexOfferDollars ?? 0)) * share;
  return { share, sale, cost, credits, effCost: cost - credits, profit: sale - cost + credits };
}
