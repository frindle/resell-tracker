'use client';
import type { DeliveryDisplay } from '@/lib/deliveryVsReceived';

const BADGE = 'inline-flex items-center justify-center px-1.5 py-0.5 rounded text-xs font-medium max-w-full text-center whitespace-normal break-words';

/**
 * Carrier delivery and group receipt as two separate facts. `short` for list rows: ONE badge that can wrap inside
 * its cell, the most useful fact first, the rest in its tooltip. `long` for the order detail (one line). A delivered
 * package the group has not received yet is amber. `noTracking` puts the red "No tracking" here instead of under the buyer.
 */
export default function DeliveryBadge({ d, form, noTracking = false }: { d: DeliveryDisplay | null | undefined; form: 'short' | 'long'; noTracking?: boolean }) {
  if (form === 'long') {
    if (!d) return null;
    return (
      <p className={`text-sm ${d.late ? 'text-amber-300' : 'text-gray-400'}`}>
        {d.received ? `${d.delivered} · ${d.received}` : d.delivered}
      </p>
    );
  }
  const full = d ? (d.received ? `${d.delivered} · ${d.received}` : d.delivered) : '';
  // Nothing has shipped as far as we know: the missing tracking is the useful thing to say.
  if (noTracking && (!d || (!d.deliveredOk && !d.receivedOk && !d.late))) {
    return <span className={`${BADGE} bg-red-900/50 text-red-300`} title={full ? `No tracking number · ${full}` : 'No tracking number'}>No tracking</span>;
  }
  if (!d) return null;
  // Not received (the one to act on) or received comes first; the carrier fact goes in the tooltip.
  if (d.receivedShort && (d.late || d.receivedOk || /^Not received/.test(d.receivedShort))) {
    const cls = d.late ? 'bg-amber-900/50 text-amber-300' : d.receivedOk ? 'bg-blue-900/50 text-blue-300' : 'bg-gray-800 text-gray-400';
    return <span className={`${BADGE} ${cls}`} title={full}>{d.receivedShort}</span>;
  }
  return (
    <span className={`${BADGE} ${d.deliveredOk ? 'bg-green-900/50 text-green-300' : 'bg-gray-800 text-gray-400'}`} title={full}>
      {d.deliveredShort}
    </span>
  );
}
