/**
 * Which auto-submit channel a buyer name maps to.
 *
 * Policy: BG and BigSky MAY auto-submit tracking on upload; BFMR must NEVER
 * auto-submit. The old inline branch in autoSubmitTracking.ts submitted BFMR
 * tracking with no quantity awareness — the wrong-quantity bug. BFMR tracking
 * goes out ONLY via the manual reservation-linker (submitTrackingForReservation),
 * which is quantity/split-aware through lib/bfmrPushGate.ts. So a BFMR buyer
 * name maps to `null` here: "no auto-submit channel", not an error.
 */

export type AutoSubmitChannel = 'BG' | 'BigSky';

/**
 * Returns the auto-submit channel for a buyer name, or null when tracking
 * must NOT be auto-submitted (BFMR — manual-only, quantity-aware path — and
 * any unrecognized buyer). Matching is case-insensitive.
 */
export function autoSubmitChannel(buyerName: string | null | undefined): AutoSubmitChannel | null {
  const name = (buyerName ?? '').toLowerCase();
  if (name.includes('buyinggroup') || name.includes('buying group')) return 'BG';
  if (name.includes('bigsky') || name.includes('big sky')) return 'BigSky';
  // BFMR and everything else: never auto-submit. See the module doc for why.
  return null;
}
