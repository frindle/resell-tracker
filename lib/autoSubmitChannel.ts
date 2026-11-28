/**
 * Which auto-submit channel a buyer name maps to.
 *
 * Policy: BG and BigSky MAY auto-submit tracking on upload. BFMR is NOT a
 * channel here: the old inline branch in autoSubmitTracking.ts submitted BFMR
 * tracking with no quantity awareness — the wrong-quantity bug. BFMR tracking
 * goes out only through lib/bfmrAutoSubmit.ts, which sends a captured package
 * only when the package matcher (lib/bfmrPackageMatch.ts) decides it is an
 * exact, quantity-aware fit (mode set by the `bfmr_auto_submit` setting:
 * off / plan / on), or by hand via the reservation linker. So a BFMR buyer
 * name maps to `null` here: "not handled by this upload-time channel", not an
 * error.
 */

export type AutoSubmitChannel = 'BG' | 'BigSky';

/**
 * Returns the auto-submit channel for a buyer name, or null when tracking
 * must NOT be auto-submitted by this path (BFMR goes through the package
 * matcher, lib/bfmrAutoSubmit.ts; any unrecognized buyer). Matching is
 * case-insensitive.
 */
export function autoSubmitChannel(buyerName: string | null | undefined): AutoSubmitChannel | null {
  const name = (buyerName ?? '').toLowerCase();
  if (name.includes('buyinggroup') || name.includes('buying group')) return 'BG';
  if (name.includes('bigsky') || name.includes('big sky')) return 'BigSky';
  // BFMR and everything else: never auto-submit. See the module doc for why.
  return null;
}
