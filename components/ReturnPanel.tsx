'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type ReturnStatus = 'initiated' | 'shipped' | 'dropped_off' | 'refunded' | 'written_off';

type Props = {
  orderId: number;
  returnStatus: string | null;
  returnTracking: string | null;
  locked: boolean;
};

async function patchOrder(id: number, data: Record<string, unknown>) {
  const res = await fetch(`/api/orders/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
}

const STATUS_LABELS: Record<ReturnStatus, string> = {
  initiated: 'Return Initiated',
  shipped: 'Return Shipped',
  dropped_off: 'Dropped Off',
  refunded: 'Refund Received',
  written_off: 'Written Off (Loss)',
};

export default function ReturnPanel({ orderId, returnStatus, returnTracking, locked }: Props) {
  const router = useRouter();
  const [trackingInput, setTrackingInput] = useState(returnTracking ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const status = returnStatus as ReturnStatus | null;
  const isTerminal = status === 'refunded' || status === 'written_off';

  async function advance(nextStatus: ReturnStatus, extra: Record<string, unknown> = {}) {
    setBusy(true);
    setError('');
    try {
      const patch: Record<string, unknown> = { returnStatus: nextStatus, ...extra };
      if (trackingInput.trim()) patch.returnTracking = trackingInput.trim();

      if (nextStatus === 'refunded') {
        // Zero out cost and mark resolved — full refund received
        patch.cost = 0;
        patch.shippingCost = 0;
        patch.insuranceCost = 0;
        patch.salePrice = 0;
        patch.salePriceSynced = true;
        patch.overdueAt = null;
      }
      if (nextStatus === 'written_off') {
        // Mark as lost (write-off shows as loss in P&L)
        patch.lost = true;
      }

      await patchOrder(orderId, patch);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (isTerminal) {
    const isRefunded = status === 'refunded';
    return (
      <div className={`rounded-lg border px-4 py-3 ${isRefunded ? 'bg-green-950/30 border-green-800' : 'bg-gray-900 border-gray-700'}`}>
        <p className={`text-sm font-medium ${isRefunded ? 'text-green-300' : 'text-gray-400'}`}>
          {isRefunded ? '✓' : '✗'} {STATUS_LABELS[status]}
        </p>
        {returnTracking && (
          <p className="text-xs text-gray-500 mt-0.5">Return tracking: {returnTracking}</p>
        )}
        {isRefunded && (
          <p className="text-xs text-green-500/70 mt-0.5">Cost zeroed — $0 net on this order.</p>
        )}
      </div>
    );
  }

  return (
    <div className="bg-orange-950/20 border border-orange-800/50 rounded-lg p-4 space-y-3">
      <p className="text-sm font-medium text-orange-300">
        Return {status ? `— ${STATUS_LABELS[status]}` : 'Required'}
      </p>

      {/* Return tracking number input — shown until dropped_off/terminal */}
      {status !== 'dropped_off' && !locked && (
        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder="Return tracking # (if shipping label)"
            value={trackingInput}
            onChange={e => setTrackingInput(e.target.value)}
            className="flex-1 bg-gray-900 border border-gray-700 rounded-md px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-orange-500"
          />
        </div>
      )}
      {returnTracking && status === 'dropped_off' && (
        <p className="text-xs text-gray-500">Return tracking: {returnTracking}</p>
      )}

      {!locked && (
        <div className="flex flex-wrap gap-2">
          {/* Progression buttons */}
          {status === null && (
            <button onClick={() => advance('initiated')} disabled={busy}
              className="bg-orange-900/50 hover:bg-orange-800/50 disabled:opacity-50 text-orange-300 text-sm px-3 py-1.5 rounded-md transition-colors">
              {busy ? 'Saving…' : 'Initiate Return'}
            </button>
          )}
          {(status === null || status === 'initiated') && (
            <>
              <button onClick={() => advance('shipped')} disabled={busy}
                className="bg-orange-900/50 hover:bg-orange-800/50 disabled:opacity-50 text-orange-300 text-sm px-3 py-1.5 rounded-md transition-colors">
                {busy ? 'Saving…' : 'Mark Shipped'}
              </button>
              <button onClick={() => advance('dropped_off')} disabled={busy}
                className="bg-orange-900/50 hover:bg-orange-800/50 disabled:opacity-50 text-orange-300 text-sm px-3 py-1.5 rounded-md transition-colors">
                {busy ? 'Saving…' : 'Mark Dropped Off'}
              </button>
            </>
          )}
          {(status === 'shipped' || status === 'dropped_off') && (
            <button onClick={() => {
              if (!confirm('Confirm refund was posted to your account? This will zero out the cost and mark the order resolved.')) return;
              advance('refunded');
            }} disabled={busy}
              className="bg-green-900/50 hover:bg-green-800/50 disabled:opacity-50 text-green-300 text-sm px-3 py-1.5 rounded-md transition-colors">
              {busy ? 'Saving…' : '✓ Refund Posted'}
            </button>
          )}

          {/* Write-off always available until terminal */}
          <button onClick={() => {
            if (!confirm('Write off as a loss? This marks the item as lost with no recovery.')) return;
            advance('written_off');
          }} disabled={busy}
            className="bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-400 text-sm px-3 py-1.5 rounded-md transition-colors">
            {busy ? 'Saving…' : 'Write Off as Loss'}
          </button>
        </div>
      )}

      {locked && (
        <p className="text-xs text-gray-500">Unlock order to update return status.</p>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
