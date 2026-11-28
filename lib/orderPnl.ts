// The one place an order's profit is worked out. Analytics totals (calcStats),
// the home page, the orders list and the order form preview all call this, so
// they can't drift apart again (each used to do its own arithmetic, and only
// calcStats knew about partly sent gift card orders).
//
//   cost    = cost + shipping + insurance - returnedCost   (returned units are out of salePrice too)
//   credits = cashback + portal cashback + Amex offer dollars
//
// The Costco member reward (Costco cash) is NOT a credit: like card points it
// is a rewards balance, counted beside points and kept out of profit.
//   profit  = sale - share × (cost - credits)
//
// share is the part of a gift card order sent to Card Center, by face value
// (lib/giftCardShare.ts). salePrice only covers the sent cards; the rest is
// still inventory. Orders without gift cards have share 1.
import { submittedShare, type CardForShare } from './giftCardShare.ts';

export type OrderMoney = {
  salePrice: number | null;
  /** Dollars the group paid under salePrice on a finished order (Order.bgShortPaid): profit uses what was paid. */
  bgShortPaid?: number | null;
  cost: number;
  shippingCost: number;
  insuranceCost?: number | null;
  returnedCost?: number | null;
  cashbackAmount: number;
  portalCashback?: number | null;
  amexOfferDollars?: number | null;
  /** Costco Executive reward (lib/costcoReward.ts). Counted like points: reported as `reward`, never in profit. */
  memberReward?: number | null;
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
  /** Costco cash (member reward) dollars, scaled to the share. Not part of credits or profit. */
  reward: number;
  /** cost - credits: the effective cost of what was sold. */
  effCost: number;
  profit: number;
};

export function orderPnl(o: OrderMoney): OrderPnl {
  const share = submittedShare(o.giftCards);
  const sale = Math.max(0, (o.salePrice ?? 0) - (o.salePrice != null && o.bgShortPaid ? o.bgShortPaid : 0));
  const cost = (o.cost + o.shippingCost + (o.insuranceCost ?? 0) - (o.returnedCost ?? 0)) * share;
  const credits = (o.cashbackAmount + (o.portalCashback ?? 0) + (o.amexOfferDollars ?? 0)) * share;
  const reward = (o.memberReward ?? 0) * share;
  return { share, sale, cost, credits, reward, effCost: cost - credits, profit: sale - cost + credits };
}
