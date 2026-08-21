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
