'use client';

import { useEffect, useState } from 'react';

// Per-reservation tracking-submit UI. Surfaces under the BFMR Reservations
// block on the order detail page. User assembles `tracker_data` rows
// (qty + tracking number) by hand for each linked reservation and submits.
//
// Hidden until BFMR_SUBMIT_UI_ENABLED is set on the server. Once we have
// a captured partial-submit GET response we'll adjust the "remaining qty"
// math (today we just cap at reservation.qty; later we'll subtract
// already-submitted shipment rows from BFMR's GET).

type Reservation = {
  id: number;
  reserveId: string | null;
  bfmrOrderId: string | null;
  trackingNumber: string | null;
  dealTitle: string | null;
  itemName: string | null;
  status: string;
  qty: number;
  purchaseId: string | null;
  myTrackerId: number | null;
  dealId: number | null;
  itemId: number | null;
  orderLinks: Array<{ id: number; orderId: number }>;
};

type Row = { qty: number; trackingNumber: string };

export default function BfmrSubmitTracking({ orderId, trackingNumbers }: { orderId: number; trackingNumbers: string | null }) {
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [rowsByRes, setRowsByRes] = useState<Record<number, Row[]>>({});
  const [submitting, setSubmitting] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const trackings = (trackingNumbers ?? '').split(',').map(t => t.trim()).filter(Boolean);

  useEffect(() => {
    fetch(`/api/bfmr/reservations?orderId=${orderId}`)
      .then(r => r.json() as Promise<{ reservations?: Reservation[] }>)
      .then(d => {
        const linked = (d.reservations ?? []).filter(r => r.orderLinks.some(l => l.orderId === orderId));
        setReservations(linked);
        const init: Record<number, Row[]> = {};
        for (const r of linked) {
          init[r.id] = [{ qty: r.qty, trackingNumber: trackings[0] ?? '' }];
        }
        setRowsByRes(init);
      })
      .catch(e => setError(String(e)));
  }, [orderId]);

  function updateRow(resId: number, idx: number, patch: Partial<Row>) {
    setRowsByRes(prev => ({
      ...prev,
      [resId]: prev[resId].map((r, i) => i === idx ? { ...r, ...patch } : r),
    }));
  }

  function addRow(resId: number) {
    setRowsByRes(prev => ({
      ...prev,
      [resId]: [...prev[resId], { qty: 1, trackingNumber: trackings[prev[resId].length] ?? '' }],
    }));
  }

  function removeRow(resId: number, idx: number) {
    setRowsByRes(prev => ({
      ...prev,
      [resId]: prev[resId].filter((_, i) => i !== idx),
    }));
  }

  async function submit(resId: number) {
    setSubmitting(resId);
    setError('');
    setSuccess('');
    try {
      const res = await fetch('/api/bfmr/submit-reservation-tracking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reservationId: resId, rows: rowsByRes[resId] }),
      });
      const d = await res.json() as { submitted?: number; totalQty?: number; error?: string };
      if (d.error) setError(d.error);
      else setSuccess(`Submitted ${d.submitted} row(s), qty ${d.totalQty} to BFMR`);
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(null);
    }
  }

  if (reservations.length === 0) return null;

  return (
    <div className="border-t border-gray-800 pt-6 space-y-3">
      <h2 className="text-lg font-semibold text-white">Submit tracking to BFMR</h2>
      {error && <div className="text-xs text-red-400">{error}</div>}
      {success && <div className="text-xs text-emerald-400">{success}</div>}
      {reservations.map(r => {
        const rows = rowsByRes[r.id] ?? [];
        const totalQty = rows.reduce((s, x) => s + (Number.isFinite(x.qty) ? x.qty : 0), 0);
        const overAllocated = totalQty > r.qty;
        const allHaveTracking = rows.every(x => x.trackingNumber.trim().length >= 8);
        const canSubmit = rows.length > 0 && totalQty > 0 && !overAllocated && allHaveTracking;
        const missingIds = !r.purchaseId || !r.myTrackerId || !r.dealId || !r.itemId || !r.bfmrOrderId;
        return (
          <div key={r.id} className="bg-gray-900 border border-gray-800 rounded-md p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm text-white truncate">
                {r.itemName || r.dealTitle || 'Reservation'} ×{r.qty}
              </div>
              <button
                onClick={() => submit(r.id)}
                disabled={!canSubmit || submitting === r.id || missingIds}
                className="bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-xs px-3 py-1 rounded transition-colors"
              >
                {submitting === r.id ? 'Submitting…' : 'Submit to BFMR'}
              </button>
            </div>
            {missingIds && (
              <div className="text-xs text-amber-400">
                Reservation is missing BFMR IDs (purchase/tracker/deal/item/order). Sync reservations from BFMR first.
              </div>
            )}
            <div className="space-y-1">
              {rows.map((row, idx) => (
                <div key={idx} className="flex items-center gap-2 text-xs">
                  <label className="text-gray-400 flex items-center gap-1">
                    Qty
                    <input
                      type="number"
                      min={1}
                      value={row.qty}
                      onChange={e => updateRow(r.id, idx, { qty: Math.max(1, parseInt(e.target.value) || 1) })}
                      className="bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-xs text-white w-14 focus:outline-none focus:border-blue-500"
                    />
                  </label>
                  <label className="text-gray-400 flex items-center gap-1 flex-1">
                    Tracking
                    <select
                      value={row.trackingNumber}
                      onChange={e => updateRow(r.id, idx, { trackingNumber: e.target.value })}
                      className="bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-xs text-white flex-1 focus:outline-none focus:border-blue-500"
                    >
                      <option value="">— select tracking —</option>
                      {trackings.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </label>
                  {rows.length > 1 && (
                    <button
                      onClick={() => removeRow(r.id, idx)}
                      className="text-gray-500 hover:text-red-400 px-1"
                      title="Remove row"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
              <button
                onClick={() => addRow(r.id)}
                className="text-xs text-blue-400 hover:underline"
              >
                + Split (add row)
              </button>
            </div>
            <div className={`text-xs ${overAllocated ? 'text-red-400' : totalQty === r.qty ? 'text-emerald-400' : 'text-gray-500'}`}>
              Allocated {totalQty} of {r.qty}{totalQty < r.qty ? ' (partial submit — remainder stays open)' : ''}{overAllocated ? ' — over-allocated' : ''}
            </div>
          </div>
        );
      })}
    </div>
  );
}
