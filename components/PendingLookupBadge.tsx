'use client';
import { pendingLookupLabel, type PendingLookup } from '@/lib/pendingLookups';

/** Says an order is waiting on an automatic page scrape. `short` for list rows (long form in the tooltip). */
export default function PendingLookupBadge({ p, form }: { p: PendingLookup | null | undefined; form: 'short' | 'long' }) {
  if (!p) return null;
  const warn = p.gaveUp || p.paused;
  return (
    <span
      suppressHydrationWarning
      title={pendingLookupLabel(p, 'long')}
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium w-fit whitespace-nowrap ${warn ? 'bg-amber-900/50 text-amber-300' : 'bg-blue-900/50 text-blue-300'}`}
    >
      {pendingLookupLabel(p, form)}
    </span>
  );
}
