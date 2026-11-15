// Pricing an order from its BigSky set-aside links (OrderBigSkyLink): the
// order's salePrice and bgExpectedPayout become Σ dealPrice × quantity, like
// BFMR reservation links and BG commitment links already do. Pure, so the
// rules are testable; lib/bigskySalePriceRecalc.ts reads and writes the DB.
//
// Who owns the price instead:
//  - BigSky paid it (salePriceSynced): the paid amount stays.
//  - BigSky scanned it (bgCredited): sync-orders sets the payout from the scan.
//  - cancelled orders are not repriced.
//  - background runs (respectLock) leave locked orders alone, and leave a
//    salePrice the user typed (one that is not the link-set payout) alone;
//    linking or unlinking by hand always reprices.

export type BigSkyLinkRow = { dealPrice: number; quantity: number };

export type BigSkyOrderState = {
  salePrice: number | null;
  bgExpectedPayout: number | null;
  salePriceSynced: boolean;
  cancelled: boolean;
  locked: boolean;
  bgCredited: boolean;
};

export type BigSkySkipReason = 'paid' | 'cancelled' | 'scanned' | 'locked' | 'user-price' | 'unchanged' | 'not-link-price';

export type BigSkyPriceDecision =
  | { action: 'skip'; reason: BigSkySkipReason }
  | { action: 'write'; salePrice: number | null; bgExpectedPayout: number | null };

const round2 = (n: number) => Math.round(n * 100) / 100;
const near = (a: number | null, b: number | null) => a != null && b != null && Math.abs(a - b) < 0.005;

export function bigSkyLinkTotal(links: BigSkyLinkRow[]): number {
  return round2(links.reduce((sum, l) => sum + l.dealPrice * l.quantity, 0));
}

/**
 * links: the order's links after the change. previousTotal: the link total
 * before an unlink, so removing the last link clears only the price the links
 * set (a price the user typed stays).
 */
export function decideBigSkySalePrice(
  order: BigSkyOrderState,
  links: BigSkyLinkRow[],
  opts: { previousTotal?: number | null; respectLock?: boolean } = {},
): BigSkyPriceDecision {
  if (order.salePriceSynced) return { action: 'skip', reason: 'paid' };
  if (order.cancelled) return { action: 'skip', reason: 'cancelled' };
  if (order.bgCredited) return { action: 'skip', reason: 'scanned' };
  if (order.locked && opts.respectLock) return { action: 'skip', reason: 'locked' };

  if (links.length === 0) {
    const prev = opts.previousTotal;
    if (prev == null || prev <= 0) return { action: 'skip', reason: 'unchanged' };
    const salePrice = near(order.salePrice, prev) ? null : order.salePrice;
    const bgExpectedPayout = near(order.bgExpectedPayout, prev) ? null : order.bgExpectedPayout;
    if (salePrice === order.salePrice && bgExpectedPayout === order.bgExpectedPayout) {
      return { action: 'skip', reason: 'not-link-price' };
    }
    return { action: 'write', salePrice, bgExpectedPayout };
  }

  const total = bigSkyLinkTotal(links);
  if (near(order.salePrice, total) && near(order.bgExpectedPayout, total)) return { action: 'skip', reason: 'unchanged' };
  if (opts.respectLock && order.salePrice != null && !near(order.salePrice, order.bgExpectedPayout)) {
    return { action: 'skip', reason: 'user-price' };
  }
  return { action: 'write', salePrice: total, bgExpectedPayout: total };
}
