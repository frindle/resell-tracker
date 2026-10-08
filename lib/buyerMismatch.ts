// "Wrong group" (Order.buyerMismatch) as seen by the BFMR sync: the order is
// assigned to a BG-style group, but BFMR actually has it. "Has it" means BFMR
// received or paid for it -- a tracker row in "purchased" state only means the
// purchase was logged at BFMR, which happens for orders that end up shipped to
// BuyingGroup (order 967: BG had the payout, BFMR only "purchased").
// Returns the value to write, or undefined to leave the flag alone. Orders
// assigned to BFMR are left to lib/bgSync.ts, which owns the reverse case.
export const BG_GROUP_RE = /bigsky|buyinggroup|buying.?group/i;

export function bfmrSyncBuyerMismatch(buyerName: string, bfmrHasIt: boolean, current: boolean): boolean | undefined {
  if (!BG_GROUP_RE.test(buyerName)) return undefined;
  if (bfmrHasIt && !current) return true;
  if (!bfmrHasIt && current) return false;
  return undefined;
}
