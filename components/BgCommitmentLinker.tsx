'use client';

import { useEffect, useRef, useState } from 'react';

type Commitment = {
  id: number;
  commitmentId: string;
  dealTitle: string;
  itemImage: string | null;
  count: number;
  fulfilled: number;
  assigned: number;
  remaining: number;
  expiryDay: string | null;
  price: number;
  commission: number;
  status: string;
  orderLinks: Array<{
    id: number;
    quantity: number;
    order: { id: number };
  }>;
};

type LinkRow = {
  linkId: number;
  commitment: Commitment;
  quantity: number;
};

function fmtDate(s: string | null) {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtCurrency(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

// Token-overlap match between the order's item description and a deal
// title. Distinctive tokens (model numbers, long words) count extra so
// "PS5" or "MacBook" agreeing matters more than "console" or "series".
const STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'and', 'for', 'with', 'pack', 'count', 'new', 'series', 'edition', 'bundle']);
function tokenize(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
      .filter(t => t.length >= 3 && !STOP_WORDS.has(t))
  );
}
function matchScore(desc: string, title: string): number {
  const a = tokenize(desc);
  const b = tokenize(title);
  if (a.size === 0 || b.size === 0) return 0;
  let hits = 0;
  let strong = 0;
  for (const t of a) {
    if (b.has(t)) {
      hits++;
      if (/\d/.test(t) || t.length >= 6) strong++;
    }
  }
  return hits / Math.min(a.size, b.size) + strong * 0.15;
}

export default function BgCommitmentLinker({ orderId, itemDescription }: { orderId: number; itemDescription?: string | null }) {
  const [allCommitments, setAllCommitments] = useState<Commitment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<number | ''>('');
  const [quantity, setQuantity] = useState(1);
  const [saving, setSaving] = useState(false);
  const [autoSyncing, setAutoSyncing] = useState(false);
  const didAutoSync = useRef(false);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch('/api/buyinggroup/commitments');
      const d = await res.json() as { commitments?: Commitment[]; error?: string };
      if (d.commitments) {
        setAllCommitments(d.commitments);
        return d.commitments;
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
    load().then(commitments => {
      if (didAutoSync.current || !commitments) return;
      const hasLinks = commitments.some(c =>
        c.orderLinks.some(l => l.order.id === orderId)
      );
      if (!hasLinks) {
        didAutoSync.current = true;
        setAutoSyncing(true);
        fetch('/api/buyinggroup/sync-commitments', { method: 'POST' })
          .then(() => load())
          .finally(() => setAutoSyncing(false));
      }
    });
  }, []);

  // Links involving THIS order
  const linkedHere: LinkRow[] = allCommitments.flatMap(c =>
    c.orderLinks
      .filter(l => l.order.id === orderId)
      .map(l => ({ linkId: l.id, commitment: c, quantity: l.quantity }))
  );

  // Commitments available to link — open and not yet linked to this order.
  // BG flips a commitment to "PARTIALLY FULFILLED" as soon as the first slot
  // ships; the remaining slots are still linkable. Filtering on remaining > 0
  // alone would be enough (VOIDED / FULFILLED both have 0 remaining), but
  // we keep the status whitelist to defend against future BG status values.
  const OPEN_STATUSES = new Set(['ACTIVE', 'PARTIALLY FULFILLED']);
  const linkable = allCommitments.filter(c =>
    OPEN_STATUSES.has(c.status)
    && c.remaining > 0
    && !linkedHere.some(l => l.commitment.id === c.id)
  );

  // Ranked suggestions: open commitments whose deal title overlaps the
  // order's item description. Shown as one-click cards above the manual
  // dropdown — the commitment is the only linkable signal until BG
  // processes the shipment, so surfacing the likely match saves hunting
  // through the full commitment list on every order.
  const suggestions = itemDescription
    ? linkable
        .map(c => ({ c, score: matchScore(itemDescription, c.dealTitle) }))
        .filter(s => s.score >= 0.5)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
    : [];

  async function addLink(commitmentIdArg?: number, quantityArg?: number) {
    const cid = commitmentIdArg ?? selectedId;
    const qty = quantityArg ?? quantity;
    if (cid === '' || qty < 1) return;
    setSaving(true);
    try {
      const res = await fetch('/api/buyinggroup/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId, commitmentId: cid, quantity: qty }),
      });
      const d = await res.json() as { id?: number; salePrice?: number; error?: string };
      if (d.error) setError(d.error);
      else {
        setSelectedId('');
        setQuantity(1);
        if (d.salePrice != null) window.dispatchEvent(new CustomEvent('sale-price-updated', { detail: d.salePrice }));
        await load();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function removeLink(linkId: number) {
    if (!confirm('Remove this commitment link?')) return;
    try {
      const res = await fetch(`/api/buyinggroup/links/${linkId}`, { method: 'DELETE' });
      const d = await res.json() as { salePrice?: number };
      if (d.salePrice != null) window.dispatchEvent(new CustomEvent('sale-price-updated', { detail: d.salePrice }));
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="border-t border-gray-800 pt-6 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-white">BuyingGroup Commitments</h2>
        <a href="/buyinggroup/commitments" className="text-xs text-gray-500 hover:text-blue-400">All commitments →</a>
      </div>

      {error && <div className="text-xs text-red-400">{error}</div>}
      {loading || autoSyncing ? (
        <div className="text-xs text-gray-500">{autoSyncing ? 'Syncing commitments from BG…' : 'Loading…'}</div>
      ) : (
        <>
          {linkedHere.length === 0 ? (
            <p className="text-xs text-gray-500">No commitments linked to this order yet.</p>
          ) : (
            <div className="space-y-2">
              {linkedHere.map(l => {
                const c = l.commitment;
                return (
                  <div key={l.linkId} className="flex items-center gap-3 bg-gray-900 border border-gray-800 rounded-md p-2">
                    {c.itemImage ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={c.itemImage} alt="" className="w-10 h-10 rounded object-cover bg-gray-800 flex-shrink-0" />
                    ) : (
                      <div className="w-10 h-10 rounded bg-gray-800 flex-shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-white truncate">{c.dealTitle}</div>
                      <div className="text-xs text-gray-500">
                        {c.commitmentId} · qty {l.quantity} · {fmtCurrency(c.price + (c.commission ?? 0))} payout ea
                        {c.commission > 0 && <span className="text-gray-600"> ({fmtCurrency(c.price)} + {fmtCurrency(c.commission)} commission)</span>}
                        {' '}· expires {fmtDate(c.expiryDay)}
                      </div>
                    </div>
                    <button
                      onClick={() => removeLink(l.linkId)}
                      className="text-xs text-gray-500 hover:text-red-400 px-2 py-1"
                      title="Remove link"
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {linkable.length === 0 && linkedHere.length === 0 && (
            <p className="text-xs text-gray-500 mt-1">
              No active commitments available to link.{' '}
              <a href="/buyinggroup/commitments" className="text-blue-400 hover:underline">Sync from BG</a>.
            </p>
          )}

          {suggestions.length > 0 && linkedHere.length === 0 && (
            <div className="pt-2 border-t border-gray-800 space-y-1.5">
              <div className="text-xs text-gray-500 font-medium">Suggested matches</div>
              {suggestions.map(({ c }) => (
                <div key={c.id} className="flex items-center gap-3 bg-blue-950/20 border border-blue-900/40 rounded-md p-2">
                  {c.itemImage ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.itemImage} alt="" className="w-8 h-8 rounded object-cover bg-gray-800 flex-shrink-0" />
                  ) : (
                    <div className="w-8 h-8 rounded bg-gray-800 flex-shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-gray-200 truncate">{c.dealTitle}</div>
                    <div className="text-xs text-gray-500">
                      {c.commitmentId} · {c.remaining}/{c.count} open · {fmtCurrency(c.price + (c.commission ?? 0))} payout ea · expires {fmtDate(c.expiryDay)}
                    </div>
                  </div>
                  <button
                    onClick={() => addLink(c.id, 1)}
                    disabled={saving}
                    className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs px-2.5 py-1 rounded transition-colors flex-shrink-0"
                    title="Link 1 unit of this order to this commitment"
                  >
                    {saving ? '…' : 'Link'}
                  </button>
                </div>
              ))}
            </div>
          )}

          {linkable.length > 0 && (
            <div className="flex flex-wrap gap-2 items-center pt-2 border-t border-gray-800">
              <select
                value={selectedId}
                onChange={e => setSelectedId(e.target.value === '' ? '' : parseInt(e.target.value))}
                className="bg-gray-900 border border-gray-700 rounded-md px-2 py-1.5 text-sm text-gray-300 focus:outline-none focus:border-blue-500 flex-1 min-w-0"
              >
                <option value="">— pick a commitment —</option>
                {linkable.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.commitmentId} · {c.dealTitle.slice(0, 60)} · {c.remaining}/{c.count} · {fmtCurrency(c.price + (c.commission ?? 0))} payout ea
                  </option>
                ))}
              </select>
              <input
                type="number"
                min={1}
                value={quantity}
                onChange={e => setQuantity(Math.max(1, parseInt(e.target.value) || 1))}
                className="bg-gray-900 border border-gray-700 rounded-md px-2 py-1.5 text-sm text-white w-20 focus:outline-none focus:border-blue-500"
                title="Quantity from this order to assign to the commitment"
              />
              <button
                onClick={() => addLink()}
                disabled={saving || selectedId === ''}
                className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm px-3 py-1.5 rounded-md transition-colors"
              >
                {saving ? 'Saving…' : 'Link'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
