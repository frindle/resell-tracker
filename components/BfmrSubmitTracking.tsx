'use client';

import { useEffect, useRef, useState } from 'react';

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
  remainingQty: number;
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

  // Starts from the server-rendered value, then stays live as the user
  // types in OrderForm's tracking-numbers field — without this, a newly
  // entered tracking number wasn't selectable here until Save was clicked
  // up top and the page reloaded.
  const [liveTrackingNumbers, setLiveTrackingNumbers] = useState(trackingNumbers ?? '');
  const trackings = liveTrackingNumbers.split(',').map(t => t.trim()).filter(Boolean);

  // A reservation's row(s) are "pristine" until the user manually edits
  // them (split, remove, or hand-type a tracking number) — only pristine
  // single-row reservations get auto-filled when a new tracking number
  // comes in live, so a manual split/edit in progress is never clobbered.
  // Plain bookkeeping, not view state — a ref, not useState, so updating
  // it doesn't itself need to trigger a render.
  const pristineRef = useRef<Record<number, boolean>>({});

  useEffect(() => {
    function onTrackingNumbersUpdated(e: Event) {
      const value = (e as CustomEvent<string>).detail;
      setLiveTrackingNumbers(value);
      const newest = value.split(',').map(t => t.trim()).filter(Boolean)[0] ?? '';
      // Auto-fill still-pristine single-row reservations with the newest
      // tracking number — otherwise a number typed after the page loaded
      // only became *selectable* here, never actually populated into the
      // row, which is what "still not populating" meant in practice.
      setRowsByRes(prev => {
        let changed = false;
        const next = { ...prev };
        for (const resId of Object.keys(pristineRef.current).map(Number)) {
          if (!pristineRef.current[resId]) continue;
          const rows = prev[resId];
          if (!rows || rows.length !== 1 || rows[0].trackingNumber === newest) continue;
          next[resId] = [{ ...rows[0], trackingNumber: newest }];
          changed = true;
        }
        return changed ? next : prev;
      });
    }
    window.addEventListener('tracking-numbers-updated', onTrackingNumbersUpdated);
    return () => window.removeEventListener('tracking-numbers-updated', onTrackingNumbersUpdated);
  }, []);

  function loadReservations() {
    return fetch(`/api/bfmr/reservations?orderId=${orderId}`)
      .then(r => r.json() as Promise<{ reservations?: Reservation[] }>)
      .then(d => {
        const linked = (d.reservations ?? []).filter(r => r.orderLinks.some(l => l.orderId === orderId));
        setReservations(linked);
        const init: Record<number, Row[]> = {};
        const initPristine: Record<number, boolean> = {};
        for (const r of linked) {
          init[r.id] = r.remainingQty > 0 ? [{ qty: r.remainingQty, trackingNumber: trackings[0] ?? '' }] : [];
          initPristine[r.id] = true;
        }
        setRowsByRes(init);
        pristineRef.current = initPristine;
      })
      .catch(e => setError(String(e)));
  }

  useEffect(() => {
    loadReservations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);

  function updateRow(resId: number, idx: number, patch: Partial<Row>) {
    pristineRef.current[resId] = false;
    setRowsByRes(prev => ({
      ...prev,
      [resId]: prev[resId].map((r, i) => i === idx ? { ...r, ...patch } : r),
    }));
  }

  function addRow(resId: number) {
    pristineRef.current[resId] = false;
    setRowsByRes(prev => ({
      ...prev,
      [resId]: [...prev[resId], { qty: 1, trackingNumber: trackings[prev[resId].length] ?? '' }],
    }));
  }

  function removeRow(resId: number, idx: number) {
    pristineRef.current[resId] = false;
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
      else {
        setSuccess(`Submitted ${d.submitted} row(s), qty ${d.totalQty} to BFMR`);
        await loadReservations();
      }
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
        const overAllocated = totalQty > r.remainingQty;
        const allHaveTracking = rows.every(x => x.trackingNumber.trim().length >= 8);
        const canSubmit = rows.length > 0 && totalQty > 0 && !overAllocated && allHaveTracking;
        const missingIds = !r.purchaseId || !r.myTrackerId || !r.dealId || !r.itemId || !r.bfmrOrderId;
        const fullySubmitted = r.remainingQty <= 0;
        const listId = `tracking-options-${r.id}`;
        return (
          <div key={r.id} className="bg-gray-900 border border-gray-800 rounded-md p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm text-white truncate">
                {r.itemName || r.dealTitle || 'Reservation'} ×{r.qty}
              </div>
              <button
                onClick={() => submit(r.id)}
                disabled={!canSubmit || submitting === r.id || missingIds || fullySubmitted}
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
            {fullySubmitted ? (
              <div className="text-xs text-emerald-400">
                Fully submitted — {r.qty} of {r.qty} shipped.
              </div>
            ) : (
              <>
                <datalist id={listId}>
                  {trackings.map(t => <option key={t} value={t} />)}
                </datalist>
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
                        <input
                          type="text"
                          list={listId}
                          placeholder="select or paste tracking #"
                          value={row.trackingNumber}
                          onChange={e => updateRow(r.id, idx, { trackingNumber: e.target.value })}
                          className="bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-xs text-white flex-1 focus:outline-none focus:border-blue-500"
                        />
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
                <div className={`text-xs ${overAllocated ? 'text-red-400' : totalQty === r.remainingQty ? 'text-emerald-400' : 'text-gray-500'}`}>
                  Allocated {totalQty} of {r.remainingQty} remaining ({r.qty - r.remainingQty} of {r.qty} already submitted)
                  {totalQty < r.remainingQty ? ' (partial submit — remainder stays open)' : ''}
                  {overAllocated ? ' — over-allocated' : ''}
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
