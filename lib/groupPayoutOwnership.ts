// Which sync owns an order's payout fields (bgExpectedPayout / salePrice /
// bgPaidAmount / salePriceSynced / locked). Pure, so it is unit tested.
//
// Order 952: reserved at BFMR (3 × $177 = $531), then sent to BuyingGroup,
// which received it at 3 × $179 = $537. The BFMR sync kept writing its $531
// reservation payout onto the BG-assigned order, and once the reservation was
// cancelled nothing replaced it -- so the list flagged "≠ $531" against a
// correct $537 sale price.

// The BFMR sync owns payout fields only for BFMR-assigned or unassigned
// orders; any other group's sync owns its own (bgSync already skips
// BFMR-assigned orders the same way).
export function bfmrOwnsPayout(buyerName: string | null | undefined): boolean {
  return !buyerName || /bfmr/i.test(buyerName);
}

// For a non-BFMR order BuyingGroup has fully credited, the credited receipt
// total is BG's own figure for the order. Adopt it as bgExpectedPayout when no
// BG commitment link supplies an expectation (recalcSalePrice owns those), the
// user hasn't hand-set it, and the order isn't locked. Returns the value to
// write, or undefined to leave it.
export function bgReceiptExpectedPayout(o: {
  bgExpectedPayout: number | null;
  locked: boolean;
  userEditedExpected: boolean;
  hasCommitmentLinks: boolean;
  fullyCredited: boolean;
  inBalanceAmount: number | null;
}): number | undefined {
  if (o.locked || o.userEditedExpected || o.hasCommitmentLinks || !o.fullyCredited) return undefined;
  if (o.inBalanceAmount == null || o.inBalanceAmount <= 0) return undefined;
  if (o.bgExpectedPayout != null && Math.abs(o.bgExpectedPayout - o.inBalanceAmount) <= 0.01) return undefined;
  return o.inBalanceAmount;
}
