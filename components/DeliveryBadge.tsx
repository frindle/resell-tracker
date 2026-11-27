'use client';
import type { DeliveryDisplay } from '@/lib/deliveryVsReceived';

const BADGE = 'inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium w-fit whitespace-nowrap';

/**
 * Carrier delivery and group receipt as two separate facts. `short` for list rows (two small badges),
 * `long` for the order detail (one line). A delivered package the group has not received yet is amber.
 */
export default function DeliveryBadge({ d, form }: { d: DeliveryDisplay | null | undefined; form: 'short' | 'long' }) {
  if (!d) return null;
  if (form === 'long') {
    return (
      <p className={`text-sm ${d.late ? 'text-amber-300' : 'text-gray-400'}`}>
        {d.delivered} · {d.received}
      </p>
    );
  }
  return (
    <>
      <span className={`${BADGE} ${d.deliveredOk ? 'bg-green-900/50 text-green-300' : 'bg-gray-800 text-gray-400'}`}>{d.delivered}</span>
      <span className={`${BADGE} ${d.late ? 'bg-amber-900/50 text-amber-300' : d.receivedOk ? 'bg-blue-900/50 text-blue-300' : 'bg-gray-800 text-gray-400'}`}>{d.received}</span>
    </>
  );
}
