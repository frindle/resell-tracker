'use client';

import { useEffect, useRef, useState } from 'react';

type Reservation = {
  id: number;
  reserveId: string | null;
  bfmrOrderId: string | null;
  trackingNumber: string | null;
  dealTitle: string | null;
  itemName: string | null;
  status: string;
  qty: number;
  retailPrice: number | null;
  totalPayout: number | null;
  datePaid: string | null;
  orderLinks: Array<{
    id: number;
    orderId: number;
    trackingNumber: string | null;
    quantity: number;
    value: number | null;
    order: { id: number; orderNumber: string | null; platform: string; trackingNumbers: string | null };
  }>;
};

type LinkDraft = {
  reservationId: number;
  trackingNumber: string;
  quantity: number;
  value: string;
};

function fmtCurrency(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

const STATUS_STYLES: Record<string, string> = {
  paid: 'bg-green-900/50 text-green-300',
  processed: 'bg-blue-900/50 text-blue-300',
  shipped: 'bg-blue-900/50 text-blue-300',
  pkg_received: 'bg-blue-900/50 text-blue-300',
  purchased: 'bg-yellow-900/50 text-yellow-300',
  reserved: 'bg-yellow-900/50 text-yellow-300',
  cancelled: 'bg-gray-800 text-gray-500',
};

export default function BfmrReservationLinker({ orderId, trackingNumbers }: { orderId: number; trackingNumbers: string | null }) {
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const [syncMsg, setSyncMsg] = useState('');
  const [showAllUnlinked, setShowAllUnlinked] = useState(false);
  const [allUnlinked, setAllUnlinked] = useState<Reservation[] | null>(null);
  const [loadingAll, setLoadingAll] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<LinkDraft | null>(null);
  const [autoSyncing, setAutoSyncing] = useState(false);
  const didAutoSync = useRef(false);

  const trackings = (trackingNumbers ?? '').split(',').map(t => t.trim()).filter(Boolean);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/bfmr/reservations?orderId=${orderId}`);
      const d = await res.json() as { reservations?: Reservation[]; error?: string };
      if (d.reservations) {
        setReservations(d.reservations);
        return d.reservations;
      } else {
        setError(d.error ?? 'Failed to load');
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
    return null;
  }

  useEffect(() => {
    load().then(async reservations => {
      if (!reservations) return;
      const hasLinks = reservations.some(r =>
        r.orderLinks.some(l => l.orderId === orderId)
      );
      if (hasLinks) return; // order is already linked — leave the picker dormant

      // Unlinked. Pull fresh from BFMR first (only once per mount), then
      // decide what to show in the picker.
      let matching = reservations;
      if (!didAutoSync.current) {
        didAutoSync.current = true;
        setAutoSyncing(true);
        try {
          await fetch('/api/bfmr/sync-reservations', { method: 'POST' });
          matching = await load() ?? matching;
        } finally {
          setAutoSyncing(false);
        }
      }
      // If nothing matched by order number or tracking, fall back to the
      // full unlinked list so the user always has something to pick from.
      const hasMatchingUnlinked = matching.some(r => r.orderLinks.length === 0);
      if (!hasMatchingUnlinked) {
        loadAllUnlinked().catch(() => {});
      }
    });
  }, []);

  async function sync() {
    setSyncing(true);
    setError('');
    try {
      const res = await fetch('/api/bfmr/sync-reservations', { method: 'POST' });
      const d = await res.json() as { synced?: number; autoLinked?: number; error?: string };
      if (d.error) setError(d.error);
      else if (d.autoLinked && d.autoLinked > 0) setSyncMsg(`Synced ${d.synced ?? 0}, auto-linked ${d.autoLinked} by order number`);
      else setSyncMsg(`Synced ${d.synced ?? 0}`);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncing(false);
    }
  }

  const linksForThisOrder = reservations.flatMap(r =>
    r.orderLinks
      .filter(l => l.orderId === orderId)
      .map(l => ({ ...l, reservation: r }))
  );

  // Show only reservations with NO existing links anywhere — if a reservation
  // is already attached to a different order, surfacing it here invites
  // double-linking. Reservations linked to *this* order appear in the
  // "Linked reservations" section above.
  // Also: hide cancelled / closed reservations from the picker — they're
  // dead. And when showing "browse all unlinked" (no exact order# match),
  // narrow to reservations whose bfmrOrderId is empty — those are the
  // ones actually waiting for assignment, vs ones already tied to a
  // different order on the BFMR side.
  const isDead = (r: Reservation) => /^(cancelled|canceled|closed)$/i.test(r.status);
  const unlinkedReservations = (showAllUnlinked ? (allUnlinked ?? []) : reservations)
    .filter(r => r.orderLinks.length === 0 && !isDead(r))
    .filter(r => !showAllUnlinked || !r.bfmrOrderId);

  async function loadAllUnlinked() {
    if (allUnlinked) { setShowAllUnlinked(true); return; }
    setLoadingAll(true);
    try {
      const res = await fetch('/api/bfmr/reservations');
      const d = await res.json() as { reservations?: Reservation[] };
      setAllUnlinked(d.reservations ?? []);
      setShowAllUnlinked(true);
    } finally {
      setLoadingAll(false);
    }
  }

  async function saveLink() {
    if (!draft) return;
    setSaving(true);
    setError('');
    try {
      const val = draft.value ? parseFloat(draft.value) : null;
      const res = await fetch('/api/bfmr/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId,
          reservationId: draft.reservationId,
          trackingNumber: draft.trackingNumber || null,
          quantity: draft.quantity,
          value: isNaN(val as number) ? null : val,
        }),
      });
      const d = await res.json() as { id?: number; error?: string };
      if (d.error) setError(d.error);
      else {
        setDraft(null);
        await load();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function splitLink(linkId: number) {
    try {
      const res = await fetch('/api/bfmr/links/split', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ linkId }),
      });
      const d = await res.json() as { error?: string };
      if (d.error) setError(d.error);
      else await load();
    } catch (e) {
      setError(String(e));
    }
  }

  async function removeLink(linkId: number) {
    if (!confirm('Remove this BFMR link?')) return;
    try {
      await fetch(`/api/bfmr/links/${linkId}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  async function updateLink(linkId: number, patch: { quantity?: number; value?: number | null; trackingNumber?: string | null }) {
    try {
      await fetch(`/api/bfmr/links/${linkId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  function startDraft(reservationId: number) {
    const r = (reservations.find(x => x.id === reservationId)) ?? allUnlinked?.find(x => x.id === reservationId);
    setDraft({
      reservationId,
      // Default to no tracking — user reserves first, then places the
      // order, then uploads tracking once shipped. Pre-selecting one
      // implies it's required. If the reservation already has tracking
      // recorded on BFMR, preserve that as a sensible default.
      trackingNumber: r?.trackingNumber ?? '',
      quantity: r?.qty ?? 1,
      value: r?.totalPayout != null ? String(r.totalPayout) : '',
    });
  }

  // Silent auto-link when the user clicks Link on a reservation that
  // already has both a tracking number AND an order_id matching one of
  // our tracking values — no need to prompt for tracking input again.
  async function quickLink(reservationId: number): Promise<boolean> {
    const r = (reservations.find(x => x.id === reservationId)) ?? allUnlinked?.find(x => x.id === reservationId);
    if (!r || !r.trackingNumber) return false;
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/bfmr/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId,
          reservationId,
          trackingNumber: r.trackingNumber,
          quantity: r.qty,
          value: r.totalPayout,
        }),
      });
      if (!res.ok) { setError((await res.json() as { error?: string }).error ?? 'Failed'); return false; }
      // Reload reservations to refresh the linked/unlinked split
      const fresh = await fetch(`/api/bfmr/reservations?orderId=${orderId}`).then(r => r.json()) as { reservations?: Reservation[] };
      if (fresh.reservations) setReservations(fresh.reservations);
      return true;
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border-t border-gray-800 pt-6 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-white">BFMR Reservations</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={sync}
            disabled={syncing}
            className="text-xs text-gray-500 hover:text-blue-400 disabled:opacity-50"
          >
            {syncing ? 'Syncing…' : 'Sync from BFMR'}
          </button>
          <a href="/bfmr" className="text-xs text-gray-500 hover:text-blue-400">BFMR Tracker →</a>
        </div>
      </div>

      {error && <div className="text-xs text-red-400">{error}</div>}
      {syncMsg && <div className="text-xs text-emerald-400">{syncMsg}</div>}

      {loading || autoSyncing ? (
        <div className="text-xs text-gray-500">{autoSyncing ? 'Syncing reservations from BFMR…' : 'Loading…'}</div>
      ) : (
        <>
          {linksForThisOrder.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs text-gray-500 font-medium">Linked reservations</div>
              {linksForThisOrder.map(l => {
                const r = l.reservation;
                const cls = STATUS_STYLES[r.status] ?? 'bg-gray-800 text-gray-400';
                return (
                  <div key={l.id} className="bg-gray-900 border border-gray-800 rounded-md p-3 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-white truncate">{r.itemName || r.dealTitle || 'Reservation'}</div>
                        <div className="text-xs text-gray-500 mt-0.5">
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${cls} mr-1`}>
                            {r.status.replace(/_/g, ' ')}
                          </span>
                          {r.bfmrOrderId && <span className="mr-2">Order: {r.bfmrOrderId}</span>}
                          {r.reserveId && <span className="mr-2">Reserve: {r.reserveId}</span>}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        {l.quantity > 1 && (
                          <button
                            onClick={() => splitLink(l.id)}
                            className="text-xs text-gray-400 hover:text-blue-400 px-2 py-1"
                            title="Peel one item off into a separate link (for split shipments)"
                          >
                            Split
                          </button>
                        )}
                        <button
                          onClick={() => removeLink(l.id)}
                          className="text-xs text-gray-500 hover:text-red-400 px-2 py-1"
                          title="Remove link"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-3 items-center text-xs">
                      <label className="flex items-center gap-1 text-gray-400">
                        Tracking:
                        <select
                          value={l.trackingNumber ?? ''}
                          onChange={e => updateLink(l.id, { trackingNumber: e.target.value || null })}
                          className="bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-xs text-white focus:outline-none focus:border-blue-500"
                        >
                          <option value="">— no tracking yet —</option>
                          {/* keep an existing-but-unscraped value selectable so we don't silently drop it */}
                          {l.trackingNumber && !trackings.includes(l.trackingNumber) && (
                            <option value={l.trackingNumber}>{l.trackingNumber}</option>
                          )}
                          {trackings.map(t => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </label>
                      <label className="flex items-center gap-1 text-gray-400">
                        Qty:
                        <input
                          type="number"
                          min={1}
                          value={l.quantity}
                          onChange={e => updateLink(l.id, { quantity: Math.max(1, parseInt(e.target.value) || 1) })}
                          className="bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-xs text-white w-14 focus:outline-none focus:border-blue-500"
                        />
                      </label>
                      <label className="flex items-center gap-1 text-gray-400">
                        Value:
                        <input
                          type="number"
                          step="0.01"
                          value={l.value ?? ''}
                          onChange={e => {
                            const v = e.target.value ? parseFloat(e.target.value) : null;
                            updateLink(l.id, { value: v });
                          }}
                          className="bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-xs text-white w-20 focus:outline-none focus:border-blue-500"
                          placeholder="$0.00"
                        />
                      </label>
                      {r.totalPayout != null && (
                        <span className="text-gray-500">
                          BFMR payout: {fmtCurrency(r.totalPayout)}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {linksForThisOrder.length === 0 && unlinkedReservations.length === 0 && (
            <p className="text-xs text-gray-500">
              No matching BFMR reservations found.{' '}
              <button onClick={sync} className="text-blue-400 hover:underline">Sync from BFMR</button>
              {' '}or{' '}
              <button onClick={loadAllUnlinked} disabled={loadingAll} className="text-blue-400 hover:underline disabled:opacity-50">
                {loadingAll ? 'loading…' : 'browse all unlinked reservations'}
              </button>.
            </p>
          )}

          {/* Link a new reservation */}
          {unlinkedReservations.length > 0 && !draft && (
            <div className="pt-2 border-t border-gray-800">
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs text-gray-500 font-medium">
                  Available reservations{showAllUnlinked ? ' (all unlinked)' : ' (matching this order)'}
                </div>
                {!showAllUnlinked && (
                  <button onClick={loadAllUnlinked} disabled={loadingAll} className="text-xs text-blue-400 hover:underline disabled:opacity-50">
                    {loadingAll ? 'loading…' : 'show all unlinked'}
                  </button>
                )}
                {showAllUnlinked && (
                  <button onClick={() => setShowAllUnlinked(false)} className="text-xs text-gray-500 hover:text-blue-400">
                    show matching only
                  </button>
                )}
              </div>
              <div className="space-y-1">
                {unlinkedReservations.map(r => {
                  const cls = STATUS_STYLES[r.status] ?? 'bg-gray-800 text-gray-400';
                  return (
                    <div key={r.id} className="flex items-center gap-2 text-xs bg-gray-900/50 border border-gray-800 rounded px-2 py-1.5">
                      <span className={`inline-flex items-center px-1.5 py-0.5 rounded font-medium ${cls}`}>
                        {r.status.replace(/_/g, ' ')}
                      </span>
                      <span className="text-gray-300 truncate flex-1">{r.itemName || r.dealTitle || r.reserveId}</span>
                      <span className="text-gray-500">qty {r.qty}</span>
                      {r.totalPayout != null && <span className="text-green-400">{fmtCurrency(r.totalPayout)}</span>}
                      {r.trackingNumber && <span className="text-gray-500 font-mono">{r.trackingNumber}</span>}
                      <button
                        onClick={async () => {
                          // If the reservation already has tracking, link silently;
                          // otherwise open the draft form so the user can pick one.
                          if (r.trackingNumber) {
                            const ok = await quickLink(r.id);
                            if (!ok) startDraft(r.id);
                          } else {
                            startDraft(r.id);
                          }
                        }}
                        className="bg-blue-600 hover:bg-blue-500 text-white px-2 py-0.5 rounded transition-colors"
                      >
                        Link
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Draft form for creating a new link */}
          {draft && (
            <div className="pt-2 border-t border-gray-800 space-y-2">
              <div className="text-xs text-gray-500 font-medium">Link reservation to this order</div>
              <div className="flex flex-wrap gap-2 items-end">
                <label className="text-xs text-gray-400">
                  Tracking <span className="text-gray-500">(optional)</span>
                  <select
                    value={draft.trackingNumber}
                    onChange={e => setDraft({ ...draft, trackingNumber: e.target.value })}
                    className="block bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-white mt-0.5 focus:outline-none focus:border-blue-500"
                  >
                    <option value="">— no tracking yet —</option>
                    {trackings.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </label>
                <label className="text-xs text-gray-400">
                  Qty {(() => {
                    const r = reservations.find(x => x.id === draft.reservationId) ?? allUnlinked?.find(x => x.id === draft.reservationId);
                    return r ? <span className="text-gray-500">(of {r.qty})</span> : null;
                  })()}
                  <input
                    type="number"
                    min={1}
                    value={draft.quantity}
                    onChange={e => setDraft({ ...draft, quantity: Math.max(1, parseInt(e.target.value) || 1) })}
                    className="block bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-white w-16 mt-0.5 focus:outline-none focus:border-blue-500"
                  />
                </label>
                <label className="text-xs text-gray-400">
                  Value ($)
                  <input
                    type="number"
                    step="0.01"
                    value={draft.value}
                    onChange={e => setDraft({ ...draft, value: e.target.value })}
                    className="block bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-white w-24 mt-0.5 focus:outline-none focus:border-blue-500"
                    placeholder="0.00"
                  />
                </label>
                <div className="flex gap-1">
                  <button
                    onClick={saveLink}
                    disabled={saving}
                    className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm px-3 py-1 rounded transition-colors"
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    onClick={() => setDraft(null)}
                    className="text-gray-500 hover:text-white text-sm px-2 py-1"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Split hint */}
          {linksForThisOrder.length > 0 && trackings.length > 1 && unlinkedReservations.length > 0 && (
            <p className="text-xs text-gray-500 pt-1">
              This order has {trackings.length} tracking numbers — link the same reservation multiple times with different tracking numbers to split items across shipments.
            </p>
          )}
        </>
      )}
    </div>
  );
}
