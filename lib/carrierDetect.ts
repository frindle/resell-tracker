// Which carrier handles a tracking number, as the lowercase names the delivery check uses. The number formats
// live in lib/carrier.ts; this adds Amazon's own format and lets a carrier name captured with the package
// (OrderPackage.carrier) win, because a bare number cannot say "Walmart".
import { carrierFromTrackingNumber } from './carrier.ts';

export type DetectedCarrier = 'fedex' | 'ups' | 'usps' | 'amazon' | 'walmart' | 'unknown';

// Amazon Logistics numbers: "TBA" plus digits.
const AMAZON_TBA = /^TBA\d{9,15}$/i;

function fromName(name: string | null | undefined): DetectedCarrier | null {
  const s = String(name ?? '').toLowerCase();
  if (!s.trim()) return null;
  if (/walmart/.test(s)) return 'walmart';
  if (/amazon|\bamzl\b/.test(s)) return 'amazon';
  if (/fedex|fed ex/.test(s)) return 'fedex';
  if (/\bups\b|united parcel/.test(s)) return 'ups';
  if (/usps|postal/.test(s)) return 'usps';
  return null;
}

export function detectCarrier(trackingNumber: string, carrierName?: string | null): DetectedCarrier {
  const named = fromName(carrierName);
  if (named) return named;
  const n = String(trackingNumber ?? '').trim().replace(/\s+/g, '');
  if (!n) return 'unknown';
  if (AMAZON_TBA.test(n)) return 'amazon';
  const c = carrierFromTrackingNumber(n);
  return c === 'FedEx' ? 'fedex' : c === 'UPS' ? 'ups' : c === 'USPS' ? 'usps' : 'unknown';
}

const digitsOnly = (s: unknown) => String(s ?? '').replace(/\D/g, '');

/**
 * Like detectCarrier, for a number that belongs to a known order. Walmart's own deliveries (store driver) are
 * stored with the order number as the tracking number, and a 15-digit order number looks like a FedEx number,
 * so that case is named first.
 */
export function detectCarrierForOrder(
  trackingNumber: string,
  carrierName: string | null | undefined,
  order: { platform?: string | null; orderNumber?: string | null },
): DetectedCarrier {
  const n = digitsOnly(trackingNumber);
  if (n && n === digitsOnly(order.orderNumber) && /^walmart$/i.test(String(order.platform ?? '').trim())) return 'walmart';
  return detectCarrier(trackingNumber, carrierName);
}
