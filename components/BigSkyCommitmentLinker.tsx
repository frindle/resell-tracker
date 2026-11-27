'use client';

import { useEffect, useState } from 'react';
import CommitNumberInput from '@/components/CommitNumberInput';
import { itemTitleScore } from '@/lib/itemTitleScore';
import { useBigSkySync } from '@/lib/useBigSkySync';

type Summary = {
  id: number;
  commitmentId: string;
  itemName: string;
  itemUpc: string;
  dealPrice: number;
  commitmentAmount: number;
  fulfilled: number;
  open: number;
  planned: number;
  unplanned: number;
  status: string;
  dealExpiration: string | null;
};

type Data = {
  filled: Array<{ commitment: Summary; quantity: number; date: string }>;
  links: Array<{ id: number; quantity: number; scanned: boolean; commitment: Summary }>;
  // unplanned = units free for this order; linkedQuantity > 0 when this order is already linked there.
  available: Array<Summary & { linkedQuantity: number }>;
};

// OrderForm listens for this and updates its Sale Price field in place.
function announceSalePrice(salePrice: number | null | undefined) {
  if (salePrice != null) window.dispatchEvent(new CustomEvent('sale-price-updated', { detail: salePrice }));
}

const money = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

function fmtDate(s: string | null) {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// BigSky matches scanned boxes to commitments itself, by UPC. This panel
// shows what the order's scans filled, and lets the user set the order
// aside for a commitment before it ships so /bigsky can show what is
// already covered.
export default function BigSkyCommitmentLinker({ orderId, itemDescription }: { orderId: number; itemDescription?: string | null }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [qtys, setQtys] = useState<Record<number, number>>({});
  const [showAll, setShowAll] = useState(false);
  // Link being swapped for another commitment ("Change"), or null.
  const [changingId, setChangingId] = useState<number | null>(null);

  async function load() {
    try {
      const res = await fetch(`/api/bigsky/order-links?orderId=${orderId}`);
      const d = await res.json() as Data & { error?: string };
      if (d.error) setError(d.error);
      else {
        setData(d);
        setError('');
        // A link that vanished (unlinked here or elsewhere) must not stay "being changed".
        setChangingId(id => (id != null && d.links.some(l => l.id === id) ? id : null));
      }
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => { load(); }, [orderId]);

  // The sync can reprice this order's links; tell the open form so its next
  // Save does not write the old Sale Price back.
  async function reloadAfterSync() {
    await load();
    try {
      const res = await fetch(`/api/orders/${orderId}`, { cache: 'no-store' });
      if (res.ok) announceSalePrice(((await res.json()) as { salePrice?: number | null }).salePrice);
    } catch { /* the list is already reloaded; the price field just keeps its value */ }
  }

  const { syncing, message: syncNote, sync } = useBigSkySync(reloadAfterSync);

  async function link(commitmentId: number, quantity: number) {
    setSaving(true);
    try {
      const res = await fetch('/api/bigsky/order-links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId, commitmentId, quantity, ...(changingId != null ? { replaceLinkId: changingId } : {}) }),
      });
      const d = await res.json() as { error?: string; salePrice?: number | null };
      if (d.error) setError(d.error);
      else { announceSalePrice(d.salePrice); setChangingId(null); }
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function unlink(id: number) {
    setSaving(true);
    try {
      const res = await fetch(`/api/bigsky/order-links/${id}`, { method: 'DELETE' });
      const d = await res.json() as { error?: string; salePrice?: number | null };
      if (d.error) setError(d.error);
      else announceSalePrice(d.salePrice);
      setChangingId(null);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  // While changing a link, offer only commitments this order is not already on.
  const ranked = (data?.available ?? [])
    .filter(c => changingId == null || c.linkedQuantity === 0)
    .map(c => ({ c, score: itemDescription ? itemTitleScore(itemDescription, c.itemName) : 0 }))
    .sort((a, b) => b.score - a.score || a.c.id - b.c.id);
  const likely = ranked.filter(r => r.score >= 0.5);
  const shown = showAll || likely.length === 0 ? ranked : likely;

  return (
    <div className="border-t border-gray-800 pt-6 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-white">BigSky Commitments</h2>
        <div className="flex items-center gap-3">
          <button
            onClick={sync}
            disabled={syncing}
            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs px-2.5 py-1 rounded transition-colors"
          >
            {syncing ? 'Syncing…' : 'Sync from BigSky'}
          </button>
          <a href="/bigsky" className="text-xs text-gray-500 hover:text-blue-400">All commitments →</a>
        </div>
      </div>

      {syncNote && (
        <div className={`p-2 rounded-md text-xs border ${syncNote.ok ? 'bg-green-900/30 border-green-700 text-green-300' : 'bg-red-900/30 border-red-700 text-red-300'}`}>
          {syncNote.text}
        </div>
      )}
      {error && <div className="text-xs text-red-400">{error}</div>}
      {!data ? (
        <div className="text-xs text-gray-500">Loading…</div>
      ) : (
        <>
          {data.filled.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-xs text-gray-500 font-medium">Filled by BigSky scan</div>
              {data.filled.map((f, i) => (
                <div key={`${f.commitment.id}-${i}`} className="flex items-center gap-3 bg-emerald-950/20 border border-emerald-900/40 rounded-md p-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-white truncate">{f.commitment.itemName || f.commitment.itemUpc}</div>
                    <div className="text-xs text-gray-500">
                      qty {f.quantity} scanned {fmtDate(f.date)} · {money(f.commitment.dealPrice)} ea · {f.commitment.fulfilled}/{f.commitment.commitmentAmount} filled
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {data.links.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-xs text-gray-500 font-medium">Set aside for</div>
              {data.links.map(l => (
                <div key={l.id} className="flex items-center gap-3 bg-gray-900 border border-gray-800 rounded-md p-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-white truncate">{l.commitment.itemName || l.commitment.itemUpc}</div>
                    <div className="text-xs text-gray-500">
                      qty {l.quantity} · {money(l.commitment.dealPrice * l.quantity)} expected · expires {fmtDate(l.commitment.dealExpiration)}
                      {l.scanned && <span className="text-emerald-400"> · scanned</span>}
                    </div>
                  </div>
                  <button
                    onClick={() => { setChangingId(changingId === l.id ? null : l.id); setShowAll(true); }}
                    disabled={saving}
                    className={`text-xs px-2 py-1 ${changingId === l.id ? 'text-blue-400' : 'text-gray-500 hover:text-blue-400'}`}
                    title="Move this order to another commitment"
                  >
                    {changingId === l.id ? 'Cancel' : 'Change'}
                  </button>
                  <button
                    onClick={() => unlink(l.id)}
                    disabled={saving}
                    className="text-xs text-gray-500 hover:text-red-400 px-2 py-1"
                    title="Remove"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          {data.filled.length === 0 && data.links.length === 0 && (
            <p className="text-xs text-gray-500">Not scanned by BigSky or set aside for a commitment yet.</p>
          )}

          {ranked.length === 0 ? (
            data.links.length === 0 && data.filled.length === 0 && (
              <p className="text-xs text-gray-500">
                No open BigSky commitments. Use Sync from BigSky above to fetch the latest.
              </p>
            )
          ) : (
            <div className="pt-2 border-t border-gray-800 space-y-1.5">
              <div className="flex items-center justify-between">
                <div className="text-xs text-gray-500 font-medium">
                  {changingId != null ? 'Pick the commitment to move this order to' : shown === likely ? 'Likely commitments' : 'Open commitments'}
                </div>
                {likely.length > 0 && likely.length < ranked.length && (
                  <button onClick={() => setShowAll(v => !v)} className="text-xs text-gray-500 hover:text-blue-400">
                    {showAll ? 'Likely only' : `All ${ranked.length}`}
                  </button>
                )}
              </div>
              {shown.map(({ c, score }) => {
                const max = Math.max(1, c.unplanned);
                return (
                  <div key={c.id} className={`flex items-center gap-3 rounded-md p-2 ${score >= 0.5 ? 'bg-blue-950/20 border border-blue-900/40' : 'bg-gray-900 border border-gray-800'}`}>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-gray-200 truncate">{c.itemName || c.itemUpc}</div>
                      <div className="text-xs text-gray-500">
                        {c.open} owed{c.planned > 0 && <> · {c.planned} set aside</>} · {money(c.dealPrice)} ea · expires {fmtDate(c.dealExpiration)}
                      </div>
                    </div>
                    <CommitNumberInput
                      integer
                      min={1}
                      value={qtys[c.id] ?? (c.linkedQuantity || 1)}
                      onCommit={v => setQtys(prev => ({ ...prev, [c.id]: Math.min(max, v ?? 1) }))}
                      className="bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-xs text-white w-14 focus:outline-none focus:border-blue-500 flex-shrink-0"
                      title="Quantity"
                    />
                    <button
                      onClick={() => link(c.id, qtys[c.id] ?? (c.linkedQuantity || 1))}
                      disabled={saving}
                      className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs px-2.5 py-1 rounded transition-colors flex-shrink-0"
                    >
                      {saving ? '…' : changingId != null ? 'Move here' : c.linkedQuantity > 0 ? 'Update' : 'Link'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
