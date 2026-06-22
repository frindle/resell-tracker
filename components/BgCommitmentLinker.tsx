'use client';

import { useEffect, useState } from 'react';

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

export default function BgCommitmentLinker({ orderId }: { orderId: number }) {
  const [allCommitments, setAllCommitments] = useState<Commitment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<number | ''>('');
  const [quantity, setQuantity] = useState(1);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch('/api/buyinggroup/commitments');
      const d = await res.json() as { commitments?: Commitment[]; error?: string };
      if (d.commitments) setAllCommitments(d.commitments);
      else setError(d.error ?? 'Failed to load');
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  // Links involving THIS order
  const linkedHere: LinkRow[] = allCommitments.flatMap(c =>
    c.orderLinks
      .filter(l => l.order.id === orderId)
      .map(l => ({ linkId: l.id, commitment: c, quantity: l.quantity }))
  );

  // Commitments available to link — active and not yet linked to this order
  const linkable = allCommitments.filter(c =>
    c.status === 'ACTIVE'
    && c.remaining > 0
    && !linkedHere.some(l => l.commitment.id === c.id)
  );

  async function addLink() {
    if (selectedId === '' || quantity < 1) return;
    setSaving(true);
    try {
      const res = await fetch('/api/buyinggroup/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId, commitmentId: selectedId, quantity }),
      });
      const d = await res.json() as { id?: number; error?: string };
      if (d.error) setError(d.error);
      else {
        setSelectedId('');
        setQuantity(1);
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
      await fetch(`/api/buyinggroup/links/${linkId}`, { method: 'DELETE' });
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
      {loading ? (
        <div className="text-xs text-gray-500">Loading…</div>
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
                        {c.commitmentId} · qty {l.quantity} · {fmtCurrency(c.price)} ea · expires {fmtDate(c.expiryDay)}
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
                    {c.commitmentId} · {c.dealTitle.slice(0, 60)} · {c.remaining}/{c.count} remaining
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
                onClick={addLink}
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
