// Infers a shipping carrier from a tracking number's format, for
// auto-filling the buying-group submission form. Checks are ordered from
// least to most ambiguous -- the previous draft checked the generic
// 12-digit numeric bucket first, which misclassified real FedEx 12-digit
// numbers as UPS whenever they also loosely matched an overly broad UPS
// pattern. Unambiguous formats must be checked before any fallback.

const UPS_1Z = /^1Z[0-9A-Z]{6}[0-9A-Z]{2}[0-9]{8,9}$/i;
const FEDEX_15 = /^\d{15}$/;
const FEDEX_20 = /^\d{20}$/;
const FEDEX_96 = /^96\d{18,20}$/;
const USPS_PREFIXED = /^(92|93|94|82|70|23|03)\d{18,20}$/;
const USPS_INTL = /^[A-Z]{2}\d{9}US$/i;
const GENERIC_12 = /^\d{12}$/;

// FedEx 12-digit numbers end in a mod-11 check digit: weights 3,1,7 repeating
// over the first 11 digits, sum mod 11, a remainder of 10 counts as 0. A
// random 12-digit number still passes 1 time in 11, so this only backs up
// other evidence (a "tracking" label in an email that says FedEx).
const FEDEX_12_WEIGHTS = [3, 1, 7, 3, 1, 7, 3, 1, 7, 3, 1];

export function fedex12CheckDigitOk(n: string): boolean {
  if (!/^\d{12}$/.test(n)) return false;
  let sum = 0;
  for (let i = 0; i < 11; i++) sum += Number(n[i]) * FEDEX_12_WEIGHTS[i];
  return (sum % 11) % 10 === Number(n[11]);
}

/**
 * A FedEx-shaped number: 12 digits with a valid check digit, or 15 digits
 * (Ground). The shape alone can't tell a 15-digit number from an order number
 * (Walmart's are 15 digits too), so callers rule out the order's own number.
 */
export function isFedExNumber(n: string): boolean {
  return fedex12CheckDigitOk(n) || /^\d{15}$/.test(n);
}

export function carrierFromTrackingNumber(
  trackingNumber: string,
): 'UPS' | 'FedEx' | 'USPS' | null {
  const n = trackingNumber.trim().replace(/\s+/g, '');

  // 1. UPS "1Z" -- unambiguous, check first.
  if (UPS_1Z.test(n)) return 'UPS';

  // 2. FedEx less-ambiguous formats -- check before any generic numeric check.
  if (FEDEX_96.test(n) || FEDEX_20.test(n) || FEDEX_15.test(n)) return 'FedEx';

  // 3. USPS -- prefixed long numeric, or international format.
  if (USPS_PREFIXED.test(n) || USPS_INTL.test(n)) return 'USPS';

  // 4. Generic 12-digit numeric is genuinely ambiguous between UPS and
  // FedEx (both use plain 12-digit numeric tracking for some domestic
  // services), with no other signal to disambiguate on format alone.
  // Defaulting to FedEx since its 12-digit Express/Ground format is more
  // common in practice at this length -- an accepted ambiguity, not a bug.
  if (GENERIC_12.test(n)) return 'FedEx';

  return null;
}
