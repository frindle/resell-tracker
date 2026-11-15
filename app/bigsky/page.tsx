'use client';

import { useEffect, useState } from 'react';

type LinkedOrder = { id: number; orderNumber: string | null; platform: string; orderDate: string; cost: number; itemDescription: string | null };
type Fulfillment = { id: string; quantity: number; date: string; trackingNumbers: string[]; orders: LinkedOrder[] };
type Commitment = {
  id: number;
  commitmentId: string;
  dealId: string;
  itemName: string;
  itemUpc: string;
  dealPrice: number;
  commitmentAmount: number;
  fulfilled: number;
  status: string;
  dealExpiration: string | null;
  creationDate: string | null;
  lastSyncedAt: string;
  fulfillments: Fulfillment[];
  unmatchedUnits: number;
};

type Filter = 'open' | 'filled' | 'unmatched' | 'all';

const money = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

function fmtDate(s: string | null) {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function daysUntil(s: string | null): number | null {
  if (!s) return null;
  const t = new Date(s).getTime();
  return isNaN(t) ? null : Math.ceil((t - Date.now()) / 86_400_000);
}

// Units still owed. BigSky's own commitmentsRemaining is kept in the
// database but does not track committed − fulfilled, so it is not shown.
const openUnits = (c: Commitment) => Math.max(0, c.commitmentAmount - c.fulfilled);

const STATUS_STYLE: Record<string, string> = {
  UNFULFILLED: 'bg-amber-900/40 text-amber-300 border-amber-800',
  FULFILLED: 'bg-emerald-900/40 text-emerald-300 border-emerald-800',
  EXCEEDED: 'bg-blue-900/40 text-blue-300 border-blue-800',
};

export default function BigSkyCommitmentsPage() {
  const [commitments, setCommitments] = useState<Commitment[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [filter, setFilter] = useState<Filter>('open');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  async function load() {
    setLoading(true);
    try {
      const res = await fetch('/api/bigsky/commitments');
      const d = await res.json() as { commitments?: Commitment[]; error?: string };
      if (d.commitments) setCommitments(d.commitments);
      else if (d.error) setMessage({ ok: false, text: d.error });
    } catch (e) {
      setMessage({ ok: false, text: String(e) });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function sync() {
    setSyncing(true);
    setMessage(null);
    try {
      const res = await fetch('/api/bigsky/sync-commitments', { method: 'POST' });
      const text = await res.text();
      let d: { synced?: number; skipped?: number; fulfillmentsWithoutTracking?: number; error?: string };
      try { d = JSON.parse(text); } catch { d = { error: `Sync failed: HTTP ${res.status} (non-JSON response)` }; }
      if (d.error) setMessage({ ok: false, text: d.error });
      else {
        const notes = [
          d.skipped ? `${d.skipped} unreadable` : '',
          d.fulfillmentsWithoutTracking ? `${d.fulfillmentsWithoutTracking} fulfillments with no scan found` : '',
        ].filter(Boolean).join(', ');
        setMessage({ ok: true, text: `Synced ${d.synced ?? 0} commitments${notes ? ` (${notes})` : ''}` });
      }
      await load();
    } catch (e) {
      setMessage({ ok: false, text: String(e) });
    } finally {
      setSyncing(false);
    }
  }

  const toggle = (id: number) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const shown = commitments.filter(c => {
    if (filter === 'open') return openUnits(c) > 0 && (daysUntil(c.dealExpiration) ?? 1) >= 0;
    if (filter === 'filled') return openUnits(c) === 0;
    if (filter === 'unmatched') return c.unmatchedUnits > 0;
    return true;
  });

  const open = commitments.filter(c => openUnits(c) > 0 && (daysUntil(c.dealExpiration) ?? 1) >= 0);
  const unitsOpen = open.reduce((s, c) => s + openUnits(c), 0);
  const valueOpen = open.reduce((s, c) => s + openUnits(c) * c.dealPrice, 0);
  const unmatched = commitments.reduce((s, c) => s + c.unmatchedUnits, 0);
  const lastSynced = commitments.reduce<string | null>((m, c) => (!m || c.lastSyncedAt > m ? c.lastSyncedAt : m), null);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
        <div>
          <h1 className="text-2xl font-semibold text-white">BigSky Commitments</h1>
          <p className="text-sm text-gray-400 mt-1">
            {open.length} open · {unitsOpen} units owed · {money(valueOpen)} at deal price
            {unmatched > 0 && <span className="text-amber-400 ml-2">· {unmatched} filled units with no tracker order</span>}
          </p>
          {lastSynced && <p className="text-xs text-gray-500 mt-0.5">Last synced {new Date(lastSynced).toLocaleString()}</p>}
        </div>
        <div className="flex items-center gap-2">
          <select
            className="bg-gray-900 border border-gray-700 rounded-md px-3 py-1.5 text-sm text-white"
            value={filter}
            onChange={e => setFilter(e.target.value as Filter)}
          >
            <option value="open">Open</option>
            <option value="unmatched">No tracker order</option>
            <option value="filled">Filled</option>
            <option value="all">All</option>
          </select>
          <button
            onClick={sync}
            disabled={syncing}
            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-4 py-1.5 rounded-md text-sm transition-colors"
          >
            {syncing ? 'Syncing…' : 'Sync from BigSky'}
          </button>
        </div>
      </div>

      {message && (
        <div className={`mb-4 p-3 rounded-md text-sm border ${message.ok ? 'bg-green-900/30 border-green-700 text-green-300' : 'bg-red-900/30 border-red-700 text-red-300'}`}>
          {message.text}
        </div>
      )}

      {loading ? (
        <div className="text-gray-500 text-sm">Loading…</div>
      ) : shown.length === 0 ? (
        <div className="text-gray-500 text-sm py-8 text-center">
          {commitments.length === 0
            ? <>No BigSky commitments yet. Click <strong>Sync from BigSky</strong>.</>
            : 'Nothing matches this filter.'}
        </div>
      ) : (
        <div className="space-y-3">
          {shown.map(c => {
            const owed = openUnits(c);
            const left = daysUntil(c.dealExpiration);
            const expiryColor = left == null ? 'text-gray-400' : left < 0 ? (owed > 0 ? 'text-red-400' : 'text-gray-500') : left < 3 ? 'text-amber-400' : 'text-gray-400';
            const isOpen = expanded.has(c.id);
            return (
              <div key={c.id} className="bg-gray-900 border border-gray-700 rounded-lg">
                <button onClick={() => toggle(c.id)} className="w-full text-left p-4 flex gap-4 items-start">
                  <span className="text-gray-500 text-xs mt-1 w-3">{isOpen ? '▾' : '▸'}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="text-white font-medium truncate">{c.itemName || c.itemUpc}</div>
                        <div className="text-xs text-gray-500 mt-0.5">UPC {c.itemUpc} · {money(c.dealPrice)} ea</div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className="text-lg font-semibold text-white">{c.fulfilled} / {c.commitmentAmount}</div>
                        <div className="text-xs text-gray-400">
                          {owed > 0 ? <span className="text-emerald-400">{owed} owed · {money(owed * c.dealPrice)}</span> : 'complete'}
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-3 mt-2 text-xs">
                      <span className={`px-2 py-0.5 rounded border ${STATUS_STYLE[c.status] ?? 'bg-gray-800 text-gray-300 border-gray-700'}`}>{c.status}</span>
                      <span className={expiryColor}>
                        Expires {fmtDate(c.dealExpiration)}
                        {left != null && left >= 0 && <span className="ml-1">({left}d)</span>}
                      </span>
                      {c.unmatchedUnits > 0 && <span className="text-amber-400">{c.unmatchedUnits} filled with no tracker order</span>}
                    </div>
                  </div>
                </button>
                {isOpen && (
                  <div className="border-t border-gray-800 px-4 py-3 pl-11">
                    {c.fulfillments.length === 0 ? (
                      <div className="text-xs text-gray-500">No scans have filled this commitment yet.</div>
                    ) : (
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-gray-500 text-left">
                            <th className="font-normal py-1 pr-4">Scanned</th>
                            <th className="font-normal py-1 pr-4">Qty</th>
                            <th className="font-normal py-1 pr-4">Tracking</th>
                            <th className="font-normal py-1">Tracker order</th>
                          </tr>
                        </thead>
                        <tbody>
                          {c.fulfillments.map(f => (
                            <tr key={f.id || f.date} className="border-t border-gray-800 align-top">
                              <td className="py-1.5 pr-4 text-gray-300 whitespace-nowrap">{fmtDate(f.date)}</td>
                              <td className="py-1.5 pr-4 text-gray-300">{f.quantity}</td>
                              <td className="py-1.5 pr-4 text-gray-400 font-mono break-all">
                                {f.trackingNumbers.length ? f.trackingNumbers.join(', ') : <span className="text-gray-600">no scan found</span>}
                              </td>
                              <td className="py-1.5">
                                {f.orders.length === 0 ? (
                                  <span className="text-amber-400">none</span>
                                ) : (
                                  <div className="flex flex-wrap gap-1.5">
                                    {f.orders.map(o => (
                                      <a
                                        key={o.id}
                                        href={`/orders/${o.id}`}
                                        className="px-2 py-0.5 bg-gray-800 hover:bg-gray-700 rounded border border-gray-700 text-gray-200"
                                        title={o.itemDescription ?? undefined}
                                      >
                                        {o.platform} #{o.orderNumber ?? o.id} · {money(o.cost)}
                                      </a>
                                    ))}
                                  </div>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
