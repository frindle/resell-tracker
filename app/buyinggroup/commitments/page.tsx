'use client';

import { useEffect, useState } from 'react';

type Commitment = {
  id: number;
  commitmentId: string;
  dealId: string;
  dealTitle: string;
  itemImage: string | null;
  count: number;
  fulfilled: number;
  assigned: number;
  remaining: number;
  isShort: boolean;
  expiryDay: string | null;
  price: number;
  commission: number;
  total: number;
  status: string;
  lastSyncedAt: string;
  orderLinks: Array<{
    id: number;
    quantity: number;
    order: {
      id: number;
      orderNumber: string | null;
      platform: string;
      orderDate: string;
      trackingNumbers: string | null;
      cost: number;
    };
  }>;
};

function fmtCurrency(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function fmtDate(s: string | null) {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function daysUntil(s: string | null): number | null {
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - Date.now()) / 86_400_000);
}

export default function CommitmentsPage() {
  const [commitments, setCommitments] = useState<Commitment[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState('');
  const [syncResult, setSyncResult] = useState('');
  const [filter, setFilter] = useState<'all' | 'active' | 'short' | 'unfilled' | 'filled'>('active');

  async function load() {
    setLoading(true);
    try {
      const res = await fetch('/api/buyinggroup/commitments');
      const d = await res.json() as { commitments?: Commitment[]; error?: string };
      if (d.commitments) setCommitments(d.commitments);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function sync() {
    setSyncing(true);
    setSyncError('');
    setSyncResult('');
    try {
      const res = await fetch('/api/buyinggroup/sync-commitments', { method: 'POST' });
      const d = await res.json() as { synced?: number; error?: string };
      if (d.error) setSyncError(d.error);
      else setSyncResult(`Synced ${d.synced ?? 0} commitments`);
      await load();
    } catch (e) {
      setSyncError(String(e));
    } finally {
      setSyncing(false);
    }
  }

  // BG flips a commitment to "PARTIALLY FULFILLED" after the first slot
  // ships — but the remaining slots are still active work for us. Treat both
  // statuses as "open" for filter buckets.
  const isOpenStatus = (s: string) => s === 'ACTIVE' || s === 'PARTIALLY FULFILLED';
  const filtered = commitments.filter(c => {
    if (filter === 'all') return true;
    if (filter === 'active') return isOpenStatus(c.status);
    if (filter === 'short') return c.isShort;
    if (filter === 'unfilled') return isOpenStatus(c.status) && c.assigned < c.count;
    if (filter === 'filled') return c.assigned >= c.count;
    return true;
  });

  const totals = {
    count: filtered.length,
    shortCount: filtered.filter(c => c.isShort).length,
    totalCommittedValue: filtered.reduce((s, c) => s + c.total, 0),
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-semibold text-white">BuyingGroup Commitments</h1>
          <p className="text-sm text-gray-400 mt-1">
            {totals.count} {filter} commitments
            {totals.shortCount > 0 && <span className="text-amber-400 ml-2">· {totals.shortCount} short</span>}
            <span className="ml-2">· {fmtCurrency(totals.totalCommittedValue)} committed</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            className="bg-gray-900 border border-gray-700 rounded-md px-3 py-1.5 text-sm text-white"
            value={filter}
            onChange={e => setFilter(e.target.value as typeof filter)}
          >
            <option value="active">Active</option>
            <option value="unfilled">Unfilled</option>
            <option value="filled">Filled</option>
            <option value="short">Short only</option>
            <option value="all">All</option>
          </select>
          <button
            onClick={sync}
            disabled={syncing}
            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-4 py-1.5 rounded-md text-sm transition-colors"
          >
            {syncing ? 'Syncing…' : 'Sync from BG'}
          </button>
        </div>
      </div>

      {syncError && <div className="mb-4 p-3 bg-red-900/30 border border-red-700 rounded-md text-sm text-red-300">{syncError}</div>}
      {syncResult && <div className="mb-4 p-3 bg-green-900/30 border border-green-700 rounded-md text-sm text-green-300">{syncResult}</div>}

      {loading ? (
        <div className="text-gray-500 text-sm">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="text-gray-500 text-sm py-8 text-center">
          No commitments yet. Click <strong>Sync from BG</strong> to fetch from BuyingGroup.
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(c => {
            const daysLeft = daysUntil(c.expiryDay);
            const expiryColor = daysLeft == null ? 'text-gray-400' : daysLeft < 0 ? 'text-red-400' : daysLeft < 3 ? 'text-amber-400' : 'text-gray-400';
            return (
              <div key={c.id} className="bg-gray-900 border border-gray-700 rounded-lg p-4 flex gap-4">
                {c.itemImage ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.itemImage} alt="" className="w-20 h-20 rounded object-cover bg-gray-800 flex-shrink-0" />
                ) : (
                  <div className="w-20 h-20 rounded bg-gray-800 flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-white font-medium truncate">{c.dealTitle}</div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        {c.commitmentId} · {c.dealId}
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      {(() => {
                        // assigned already includes fulfilled (fulfilled is a
                        // subset). True slot usage = assigned; in-transit =
                        // assigned - fulfilled; open = count - assigned.
                        const inTransit = Math.max(0, c.assigned - c.fulfilled);
                        const open = Math.max(0, c.count - c.assigned);
                        const overBy = Math.max(0, c.assigned - c.count);
                        const overCommit = overBy > 0;
                        return (
                          <>
                            <div className={`text-lg font-semibold ${overCommit ? 'text-red-300' : 'text-white'}`}>
                              {c.assigned} / {c.count}{overCommit && <span className="text-xs ml-1 text-red-400">+{overBy} over</span>}
                            </div>
                            <div className="text-xs text-gray-400">
                              {c.fulfilled} shipped · {inTransit} in transit
                              {open > 0 && <> · <span className="text-emerald-400">{open} open</span></>}
                            </div>
                          </>
                        );
                      })()}
                    </div>
                  </div>
                  <div className="flex items-center gap-4 mt-3 text-xs">
                    <span className={`${expiryColor}`}>
                      Expires {fmtDate(c.expiryDay)}
                      {daysLeft != null && <span className="ml-1">({daysLeft}d)</span>}
                    </span>
                    <span className="text-gray-400">
                      {fmtCurrency(c.price)} ea
                      {c.commission > 0 && <> + {fmtCurrency(c.commission)} commission = {fmtCurrency(c.price + c.commission)} payout</>}
                      {' '}· {fmtCurrency(c.commission > 0 ? (c.price + c.commission) * c.count : c.total)} total
                    </span>
                    {c.isShort && (
                      <span className="text-amber-400 font-medium">⚠ Short {c.remaining}</span>
                    )}
                  </div>
                  {c.orderLinks.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-gray-800">
                      <div className="text-xs text-gray-500 mb-1">Assigned orders:</div>
                      <div className="flex flex-wrap gap-2">
                        {c.orderLinks.map(l => (
                          <a
                            key={l.id}
                            href={`/orders/${l.order.id}`}
                            className="text-xs px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded border border-gray-700"
                          >
                            {l.order.platform} #{l.order.orderNumber ?? l.order.id} · qty {l.quantity}
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
