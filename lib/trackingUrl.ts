// The public tracking page for a tracking number, and the one stored form of a number we send on to a group.
import { fedex12CheckDigitOk } from './carrier.ts';
import { detectCarrier } from './carrierDetect.ts';

/** Amazon Logistics: "TBA" plus digits. Any case or inner spaces are accepted. */
export const isAmazonTba = (t: string) => detectCarrier(t) === 'amazon' && /^TBA/i.test(t.trim());

/** What a group gets: trimmed, and a TBA number with its spaces removed and in upper case. Other carriers' numbers are left alone. */
export function normalizeTrackingForSubmit(t: string): string {
  const s = String(t ?? '').trim();
  const compact = s.replace(/\s+/g, '');
  return /^TBA\d+$/i.test(compact) ? compact.toUpperCase() : s;
}

export function trackingUrl(raw: string): string {
  const t = normalizeTrackingForSubmit(raw);
  if (/^TBA\d+$/.test(t)) return `https://track.amazon.com/tracking/${encodeURIComponent(t)}`;
  if (/^1Z[A-Z0-9]{16}$/i.test(t)) return `https://www.ups.com/track?tracknum=${t}`;
  // FedEx Ground 22-digit numbers start 96; other long 9… numbers are USPS.
  if (/^96\d{20}$/.test(t)) return `https://www.fedex.com/fedextrack/?trknbr=${t}`;
  if (/^9\d{19,21}$/.test(t)) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${t}`;
  if (/^[1-8]\d{14}$/.test(t) || fedex12CheckDigitOk(t)) return `https://www.fedex.com/fedextrack/?trknbr=${t}`;
  return `https://www.google.com/search?q=${encodeURIComponent(t + ' tracking')}`;
}
