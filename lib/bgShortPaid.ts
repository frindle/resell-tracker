// A BuyingGroup order that is finished but paid less than expected: every shipment has an
// in-balance receipt, every in-balance receipt is paid, and the paid total is still under the
// expected payout. No more money is coming, so it is not "partial". Pure, no I/O.

export type ShortPaidInput = {
  /** Every tracking number has an in-balance receipt (bgCredited / isOrderFullyCredited). */
  fullyCredited: boolean;
  /** Receipts truly paid, dollars; null when none. */
  trulyPaid: number | null;
  /** Receipts in balance (paid + verified), dollars; null when none. */
  inBalance: number | null;
  expected: number | null;
  /** The expected payout comes from links past what their commitments hold (lib/commitmentUnits.ts): not a safe basis. */
  overLinked?: boolean;
};

/** Dollars short (rounded to cents), or null when the order is not a final short pay. */
export function finalShortPay(i: ShortPaidInput): number | null {
  if (i.overLinked || !i.fullyCredited || i.trulyPaid == null || i.inBalance == null || i.expected == null) return null;
  if (Math.abs(i.trulyPaid - i.inBalance) > 0.01) return null;
  if (!(i.trulyPaid < i.expected - 0.01)) return null;
  return Math.round((i.expected - i.trulyPaid) * 100) / 100;
}

/** "BG paid $4.97 less than expected on #123", for the daily digest. */
export function shortPaidLine(orderNumber: string | null, orderId: number, short: number): string {
  return `BG paid $${short.toFixed(2)} less than expected on #${orderNumber || orderId}`;
}
