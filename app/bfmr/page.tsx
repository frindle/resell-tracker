'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import type { TrackerItem } from '@/lib/bfmr';
import { type DateWindow, DATE_WINDOWS, windowStartIso } from '@/lib/dateWindow';

type QuickFilter = 'all' | 'pending' | 'action_needed' | 'paid' | 'closed';

const QUICK_FILTERS: { value: QuickFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'action_needed', label: 'Action Needed' },
  { value: 'paid', label: 'Paid' },
  { value: 'closed', label: 'Closed' },
];

const STATUS_STYLES: Record<string, string> = {
  paid: 'bg-green-900/50 text-green-300',
  processed: 'bg-blue-900/50 text-blue-300',
  shipped: 'bg-blue-900/50 text-blue-300',
  pkg_received: 'bg-blue-900/50 text-blue-300',
  purchased: 'bg-yellow-900/50 text-yellow-300',
  reserved: 'bg-yellow-900/50 text-yellow-300',
  return: 'bg-red-900/50 text-red-300',
  returned: 'bg-red-900/50 text-red-300',
  payment_error: 'bg-red-900/50 text-red-300',
  cancelled: 'bg-gray-800 text-gray-500',
  closed: 'bg-gray-800 text-gray-500',
  set_aside: 'bg-gray-800 text-gray-400',
  deadline: 'bg-orange-900/50 text-orange-300',
};

function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_STYLES[status] ?? 'bg-gray-800 text-gray-400';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function fmt(n?: number) {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}


export default function BfmrPage() {
  const [items, setItems] = useState<TrackerItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<QuickFilter>('all');
  const [search, setSearch] = useState('');
  const [window_, setWindow] = useState<DateWindow>('3m');
  const [rejectedMap, setRejectedMap] = useState<Record<string, { name: string; reason: string }[]>>({});

  const [syncing, setSyncing] = useState(false);
  const [forceOverwrite, setForceOverwrite] = useState(false);
  const [syncResult, setSyncResult] = useState<{ updated: number; created: number; unmatched: number; total: number; withOrderNo: number; error?: string } | null>(null);

  const load = useCallback(async (qf: QuickFilter, w: DateWindow) => {
    setLoading(true);
    setError('');
    try {
      const today = new Date().toISOString().slice(0, 10);
      const p: Record<string, string> = { quick_filter: qf, page_size: '200', end_date: today };
      const sd = windowStartIso(w);
      if (sd) p.start_date = sd;
      const params = new URLSearchParams(p);
      const res = await fetch(`/api/bfmr/tracker?${params}`);
      if (res.status === 400) { setError('BFMR not configured. Add your API key in Settings.'); return; }
      if (!res.ok) { setError(`Failed to load tracker data: ${await res.text()}`); return; }
      const data = await res.json();
      setItems(data);
      // Auto-sync payouts to orders in background
      fetch('/api/bfmr/sync-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: data, force: false }),
      }).then(() => fetch('/api/bfmr/rejected-items').then(r => r.ok ? r.json() : {}).then(setRejectedMap)).catch(() => {});
    } catch {
      setError('Network error.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(filter, window_); }, [filter, window_, load]);
  useEffect(() => {
    fetch('/api/bfmr/rejected-items').then(r => r.ok ? r.json() : {}).then(setRejectedMap);
  }, []);

  async function syncToOrders() {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch('/api/bfmr/sync-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, force: forceOverwrite }),
        signal: AbortSignal.timeout(35_000),
      });
      if (!res.ok) {
        setSyncResult({ updated: 0, created: 0, unmatched: 0, total: 0, withOrderNo: 0, error: await res.text() });
      } else {
        setSyncResult(await res.json());
      }
    } catch (e) {
      setSyncResult({ updated: 0, created: 0, unmatched: 0, total: 0, withOrderNo: 0, error: String(e) });
    } finally {
      setSyncing(false);
      fetch('/api/bfmr/rejected-items').then(r => r.ok ? r.json() : {}).then(setRejectedMap);
    }
  }

  const filtered = items.filter(item => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      String(item.order_id ?? '').toLowerCase().includes(q) ||
      String(item.tracking_number ?? '').toLowerCase().includes(q) ||
      String(item.status ?? '').toLowerCase().includes(q)
    );
  });

  const totalPaid = filtered
    .filter(i => i.status === 'paid')
    .reduce((s, i) => s + parseFloat(String(i.total_payout ?? '0').replace(/,/g, '')), 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">BFMR Tracker</h1>
          <p className="text-gray-400 text-sm mt-1">
            {filtered.length} items
            {filter === 'paid' && filtered.length > 0 && (
              <> · Paid out: <span className="text-green-400">{fmt(totalPaid)}</span></>
            )}
          </p>
        </div>
      </div>

      {/* Sync to orders panel */}
      <div className="rounded-lg border border-gray-800 bg-gray-900/50 px-4 py-3 flex flex-wrap gap-3 items-center">
        <span className="text-sm text-gray-300 font-medium">Sync payouts → Orders</span>
        <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer select-none">
          <input type="checkbox" checked={forceOverwrite} onChange={e => setForceOverwrite(e.target.checked)} />
          Force overwrite
        </label>
        <button
          onClick={syncToOrders}
          disabled={syncing}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm px-4 py-1.5 rounded-md transition-colors"
        >
          {syncing ? 'Syncing…' : 'Sync'}
        </button>
        {syncResult && (
          <span className="text-sm space-y-1 block w-full">
            {syncResult.error
              ? <span className="text-red-400">Sync failed: {syncResult.error}</span>
              : <>
                  <span className="text-green-400">{syncResult.updated} updated</span>
                  {syncResult.created > 0 && <span className="text-blue-400 ml-2">· {syncResult.created} imported</span>}
                </>}
            <span className="text-gray-500 ml-2">· {syncResult.withOrderNo}/{syncResult.total} had order #</span>
            {syncResult.unmatched > 0 && (
              <span className="text-gray-500 ml-2">· {syncResult.unmatched} skipped</span>
            )}
          </span>
        )}
        <span className="text-xs text-gray-600 ml-auto">Matches by order number, fills in sale price from payout amount</span>
      </div>

      <div className="flex gap-3 flex-wrap items-center">
        <input
          type="text"
          placeholder="Search order #, tracking…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="bg-gray-900 border border-gray-700 rounded-md px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 w-56"
        />
        <div className="flex gap-1">
          {QUICK_FILTERS.map(f => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`px-3 py-1.5 rounded-md text-sm transition-colors ${filter === f.value ? 'bg-blue-600 text-white' : 'bg-gray-900 border border-gray-700 text-gray-400 hover:text-white'}`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <select
          value={window_}
          onChange={e => setWindow(e.target.value as DateWindow)}
          className="ml-auto bg-gray-900 border border-gray-700 rounded-md px-2 py-1.5 text-sm text-gray-300 focus:outline-none focus:border-blue-500"
        >
          {DATE_WINDOWS.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
        </select>
        <button
          onClick={() => load(filter, window_)}
          className="text-gray-500 hover:text-white text-sm transition-colors"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-900/20 px-4 py-3 text-sm text-red-300">
          {error}{' '}
          {error.includes('Settings') && (
            <Link href="/settings" className="underline hover:text-red-200">Go to Settings</Link>
          )}
        </div>
      )}

      {loading ? (
        <div className="text-center text-gray-500 py-12">Loading…</div>
      ) : filtered.length === 0 && !error ? (
        <div className="rounded-lg border border-dashed border-gray-700 py-12 text-center text-gray-500">
          No items found.
        </div>
      ) : (
        <div className="rounded-lg border border-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-900 text-gray-400 text-xs uppercase">
              <tr>
                <th className="px-4 py-2 text-left">Status</th>
                <th className="px-4 py-2 text-left">Order #</th>
                <th className="hidden md:table-cell px-4 py-2 text-left">Tracking</th>
                <th className="hidden sm:table-cell px-4 py-2 text-right">Retail</th>
                <th className="px-4 py-2 text-right">Paid</th>
                <th className="hidden sm:table-cell px-4 py-2 text-left">Date Paid</th>
                <th className="hidden lg:table-cell px-4 py-2 text-left">Insurance</th>
                <th className="px-4 py-2 text-left">Rejected</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {filtered.map((item, i) => {
                const rejected = item.order_id ? (rejectedMap[item.order_id] ?? []) : [];
                return (
                <tr key={item.reserve_id ?? item.purchase_id ?? item.shipment_id ?? i} className="hover:bg-gray-900/50">
                  <td className="px-4 py-3"><StatusBadge status={item.status} /></td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-300">{item.order_id || '—'}</td>
                  <td className="hidden md:table-cell px-4 py-3 font-mono text-xs text-gray-300">{item.tracking_number || '—'}</td>
                  <td className="hidden sm:table-cell px-4 py-3 text-right text-gray-400">{fmt(item.retail_price)}</td>
                  <td className="px-4 py-3 text-right">
                    {(() => {
                      const isReturn = /^(return|returned)$/i.test(String(item.status ?? ''));
                      const payout = item.total_payout != null ? parseFloat(String(item.total_payout).replace(/,/g, '')) : NaN;
                      if (isReturn) return <span className="text-red-400">{!isNaN(payout) && payout > 0 ? fmt(payout) : '—'}</span>;
                      if (!isNaN(payout) && payout > 0) return <span className="text-green-400">{fmt(payout)}</span>;
                      return '—';
                    })()}
                  </td>
                  <td className="hidden sm:table-cell px-4 py-3 text-gray-400 text-xs">
                    {item.date_paid ? new Date(item.date_paid).toLocaleDateString() : '—'}
                  </td>
                  <td className="hidden lg:table-cell px-4 py-3">
                    {item.insurance_status
                      ? <span className={`text-xs ${item.insurance_status === 'insured' ? 'text-green-400' : 'text-gray-500'}`}>
                          {item.insurance_status.replace(/_/g, ' ')}
                        </span>
                      : '—'}
                  </td>
                  <td className="px-4 py-3">
                    {rejected.length > 0 ? (
                      <div className="group relative w-fit">
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-900/50 text-red-300 cursor-default whitespace-nowrap">
                          ⚠ {rejected.length} rejected
                        </span>
                        <div className="absolute left-0 top-full mt-1 z-10 hidden group-hover:block bg-gray-900 border border-gray-700 rounded shadow-lg p-2 min-w-48 max-w-64 space-y-1">
                          {rejected.map((r, j) => (
                            <div key={j} className="text-xs">
                              <span className="text-gray-200">{r.name}</span>
                              {r.reason && <span className="text-red-400 block">{r.reason}</span>}
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : '—'}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
