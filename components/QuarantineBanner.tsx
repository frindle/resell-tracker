'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

// Shown on the order detail page when the order was quarantined by an
// address-block pattern at import time. Lets the user approve from the
// detail page without bouncing to /orders/blocked.
export default function QuarantineBanner({ orderId, pattern }: { orderId: number; pattern: string }) {
  const router = useRouter();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

  async function allow() {
    setWorking(true);
    setError('');
    try {
      const res = await fetch('/api/orders/blocked', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [orderId], action: 'allow' }),
      });
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
    <div className="bg-yellow-950/40 border border-yellow-800 rounded-lg px-4 py-3 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm text-yellow-200">
          This order is quarantined — its shipping address matched a blocked pattern at import time.
        </p>
        <p className="text-xs text-yellow-400/70 mt-0.5">
          Matched pattern: <span className="font-mono">{pattern}</span>. While quarantined the order is hidden from /orders and analytics.
        </p>
        {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
      </div>
      <button
        onClick={allow}
        disabled={working}
        className="bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-sm px-3 py-1.5 rounded-md transition-colors whitespace-nowrap flex-shrink-0"
      >
        {working ? 'Approving…' : 'Allow'}
      </button>
    </div>
  );
}
