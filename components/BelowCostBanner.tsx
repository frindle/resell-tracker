'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

// Shown on the order detail page when a BuyingGroup price change put the
// order's sale price under its cost (lib/bgPriceChange.ts).
export default function BelowCostBanner({ orderId, text }: { orderId: number; text: string }) {
  const router = useRouter();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

  async function dismiss() {
    setWorking(true);
    setError('');
    try {
      const res = await fetch(`/api/orders/${orderId}/below-cost`, { method: 'DELETE' });
      const d = await res.json();
      if (d.error) setError(d.error);
      else router.refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="bg-red-950/40 border border-red-800 rounded-lg px-4 py-3 flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-red-300">⚠ Sale price is below cost</p>
        <p className="text-xs text-red-400 mt-0.5 break-words">{text}</p>
        {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
      </div>
      <button
        onClick={dismiss}
        disabled={working}
        className="bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-200 text-sm px-3 py-1.5 rounded-md transition-colors whitespace-nowrap flex-shrink-0"
      >
        {working ? 'Dismissing…' : 'Dismiss'}
      </button>
    </div>
  );
}
