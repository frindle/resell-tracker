// BG picks the payout tier from when THEY scanned the package, which can be later than the carrier's delivery.
// This compares the tier the carrier's delivery earned with the tier BG's scan reached and the tier BG paid.
//
// The carrier date is local wall-clock time with no zone (lib/carrierPage.ts), so the tier is decided by the
// delivery's calendar day: it makes a tier when that day is on or before the day the tier's deadline falls on in
// Pacific time (the deal pages show deadlines in Pacific). BG's own scan is a real instant and is compared as one.
//
// Time-zone rule: a deadline is the end of a Pacific calendar day (07:59:59 UTC the next day in winter). The
// carrier's date is read as the calendar day shown at the delivery place, whatever the hour, so a delivery at
// 23:30 local on the deadline day is on time, and one at 00:10 the next day is not. The hour is never compared
// against the deadline's hour, because the carrier's zone is unknown and that would shift the day.
import { tierEarned, type BgTier } from './bgPayoutTiers.ts';

const CENT = 0.005;

export type TierMismatch = {
  /** The tier the carrier's delivery earned; null when it missed every deadline. */
  shouldHave: BgTier | null;
  /** The speed tier whose commission matches what BG paid; null when none does. */
  paid: BgTier | null;
  /** BG's scan reached a lower tier than the delivery earned. */
  late: boolean;
  /** Commission per unit still owed against the tier the delivery earned (0 when paid right). */
  shortfall: number;
};

const pacificDay = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

function earnedOnDay(tiers: readonly BgTier[], day: string): BgTier | null {
  let best: BgTier | null = null;
  for (const t of tiers) {
    if (t.isLabel || pacificDay(t.deliverBy) < day) continue;
    if (!best || t.commission > best.commission + CENT) best = t;
  }
  return best;
}

export function tierMismatch(input: { tiers: readonly BgTier[]; deliveredAt: Date; scannedAt: Date; paidCommission: number }): TierMismatch {
  const { tiers, deliveredAt, scannedAt, paidCommission } = input;
  const shouldHave = earnedOnDay(tiers, deliveredAt.toISOString().slice(0, 10));
  const labelPaid = tiers.find(t => t.isLabel && Math.abs(t.commission - paidCommission) < CENT) ?? null;
  const paid = labelPaid ?? tiers.find(t => !t.isLabel && Math.abs(t.commission - paidCommission) < CENT) ?? null;
  const scanTier = tierEarned(tiers, scannedAt);
  const late = !!shouldHave && (!scanTier || shouldHave.commission > scanTier.commission + CENT);
  // A commission matching a BG-label tier pays by label use, not speed, so it is never called short.
  const owed = shouldHave && !labelPaid ? Math.max(0, shouldHave.commission - paidCommission) : 0;
  return { shouldHave, paid, late, shortfall: Math.round(owed * 100) / 100 };
}

export function carrierScanLine(deliveredAt: Date, scannedAt: Date): string {
  // The delivery is already a local wall-clock day; the scan is an instant, shown as its Pacific day like the deadlines.
  return `Carrier delivered ${deliveredAt.toISOString().slice(0, 10)}; BG scanned ${pacificDay(scannedAt)}`;
}

/**
 * When the last package of the linked orders was delivered, or null unless EVERY tracking number of every order
 * has a delivered date. With one still unknown the real last delivery could be later, and a partial answer
 * could call a fair payout late.
 */
export function lastDelivery(orders: readonly (readonly string[])[], deliveredAt: (trackingNumber: string) => Date | undefined): Date | null {
  let last: Date | null = null;
  if (!orders.length) return null;
  for (const numbers of orders) {
    if (!numbers.length) return null;
    for (const n of numbers) {
      const d = deliveredAt(n);
      if (!d) return null;
      if (!last || d.getTime() > last.getTime()) last = d;
    }
  }
  return last;
}
