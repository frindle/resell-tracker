'use client';
import type { DeliveryDisplay } from '@/lib/deliveryVsReceived';

const BADGE = 'inline-flex items-center justify-center px-1.5 py-0.5 rounded text-xs font-medium max-w-full text-center whitespace-normal break-words';

/**
 * Carrier delivery and group receipt as two separate facts. `short` for list rows: ONE badge that can wrap inside
 * its cell, the most useful fact first, the rest in its tooltip. `long` for the order detail (one line). A delivered
 * package the group has not received yet is amber. `noTracking` puts the red "No tracking" here instead of under the buyer.
 */
// The facts that are known, joined. The carrier part is left out when the group already counted the package.
const joined = (d: DeliveryDisplay) => [d.delivered, d.received].filter(Boolean).join(' · ');

export default function DeliveryBadge({ d, form, noTracking = false }: { d: DeliveryDisplay | null | undefined; form: 'short' | 'long'; noTracking?: boolean }) {
  if (form === 'long') {
    if (!d || !joined(d)) return null;
    return (
      <p className={`text-sm ${d.late ? 'text-amber-300' : 'text-gray-400'}`}>
        {joined(d)}
      </p>
    );
  }
  const full = d ? joined(d) : '';
  // Nothing has shipped as far as we know: the missing tracking is the useful thing to say.
  if (noTracking && (!d || (!d.deliveredOk && !d.receivedOk && !d.late))) {
    return <span className={`${BADGE} bg-red-900/50 text-red-300`} title={full ? `No tracking number · ${full}` : 'No tracking number'}>No tracking</span>;
  }
  if (!d) return null;
  const shortText = d.deliveredShort ?? d.receivedShort;
  if (!shortText) return null;
  // Received, or delivered and still not received after LATE_RECEIPT_DAYS (the one to act on), comes first. A
  // delivery the group has not counted yet inside that grace is normal, so the cell shows the delivery and the
  // receipt goes in the tooltip.
  if (d.receivedShort && (d.late || d.receivedOk)) {
    const cls = d.late ? 'bg-amber-900/50 text-amber-300' : 'bg-blue-900/50 text-blue-300';
    return <span className={`${BADGE} ${cls}`} title={full}>{d.receivedShort}</span>;
  }
  return (
    <span className={`${BADGE} ${d.deliveredOk ? 'bg-green-900/50 text-green-300' : 'bg-gray-800 text-gray-400'}`} title={full}>
      {shortText}
    </span>
  );
}
