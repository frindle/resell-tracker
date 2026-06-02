'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { type DateWindow, DATE_WINDOWS, windowStartDate } from '@/lib/dateWindow';

type PendingOrder = {
  id: number;
  orderNumber: string | null;
  itemDescription: string | null;
  trackingNumbers: string | null;
  orderDate: string;
  cost: number;
};

// Actual BuyingGroup API receipt shape
type Receipt = {
  key: string;
  receipt_id: string;
  total: string;
  total_paid: string;
  paid: boolean;
  status: string;
  tracking?: { tracking_id?: string; track_url?: string };
  order_id?: string;
  created_dt?: string;
  modified_dt?: string;
  [key: string]: unknown;
};

function fmt(v: string | number | undefined) {
  const n = parseFloat(String(v ?? 0));
  if (isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

type Filter = 'all' | 'unpaid' | 'paid';

export default function BuyingGroupPage() {
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [pendingOrders, setPendingOrders] = useState<PendingOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [syncWindow, setSyncWindow] = useState<DateWindow>('3m');

  useEffect(() => {
    Promise.all([
      fetch('/api/buyinggroup/receipts').then(r => {
        if (r.status === 400) throw new Error('not_configured');
        if (!r.ok) throw new Error(`API error ${r.status}`);
        return r.json();
      }),
      fetch('/api/buyinggroup/pending-orders').then(r => r.ok ? r.json() : []),
    ])
      .then(([data, pending]) => {
        const payload = data?.payload as Record<string, unknown> | undefined;
        const items: Receipt[] = Array.isArray(data) ? data : ((payload?.receipts ?? data.results ?? data.data ?? []) as Receipt[]);
        setReceipts(items);
        setPendingOrders(pending as PendingOrder[]);
        fetch('/api/buyinggroup/sync-orders', { method: 'POST' }).catch(() => {});
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  async function forceSync() {
    setSyncing(true);
    setSyncMsg('');
    try {
      const res = await fetch('/api/buyinggroup/sync-orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force: true }) });
      if (res.ok) setSyncMsg('Sync complete');
      else setSyncMsg('Sync failed');
    } catch {
      setSyncMsg('Sync failed');
    } finally {
      setSyncing(false);
    }
  }

  const sinceMs = windowStartDate(syncWindow)?.getTime() ?? 0;

  // Parse BG date format "MM-DD-YYYY HH:MM:SS"
  function parseBgDate(s: string | undefined): Date | null {
    if (!s) return null;
    const [datePart, timePart] = s.split(' ');
    const [mm, dd, yyyy] = datePart.split('-');
    return new Date(`${yyyy}-${mm}-${dd}T${timePart ?? '00:00:00'}`);
  }

  const filtered = receipts.filter(r => {
    const created = parseBgDate(r.created_dt);
    if (sinceMs && created && created.getTime() < sinceMs) return false;
    if (filter === 'paid') return r.paid === true;
    if (filter === 'unpaid') return r.paid !== true;
    return true;
  });

  const totalPaid = receipts.filter(r => r.paid).reduce((sum, r) => sum + parseFloat(String(r.total_paid ?? r.total ?? 0)), 0);

  const FILTERS: { key: Filter; label: string }[] = [
    { key: 'all',    label: 'All' },
    { key: 'unpaid', label: 'Unpaid' },
    { key: 'paid',   label: 'Paid' },
  ];

  if (error === 'not_configured') {
    return (
      <div className="p-8 text-center">
        <p className="text-gray-400 mb-4">BuyingGroup credentials not configured.</p>
        <Link href="/settings" className="text-blue-400 hover:underline text-sm">Go to Settings →</Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">BuyingGroup Receipts {receipts.length > 0 && <span className="text-sm font-normal text-gray-500">({receipts.length} loaded, {filtered.length} shown)</span>}</h1>
        <div className="flex items-center gap-3">
          {totalPaid > 0 && (
            <span className="text-green-400 text-sm font-medium">Total paid: {fmt(totalPaid)}</span>
          )}
          <button
            onClick={forceSync}
            disabled={syncing}
            className="text-xs bg-gray-700 hover:bg-gray-600 disabled:opacity-50 px-3 py-1.5 rounded-md transition-colors"
          >
            {syncing ? 'Syncing…' : 'Force Re-sync'}
          </button>
          {syncMsg && <span className="text-xs text-gray-400">{syncMsg}</span>}
        </div>
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      <div className="flex gap-2 flex-wrap items-center">
        {FILTERS.map(f => (
          <button key={f.key} onClick={() => setFilter(f.key)}
            className={`text-sm px-3 py-1.5 rounded-md transition-colors ${
              filter === f.key
                ? 'bg-blue-600 text-white'
                : 'bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700'
            }`}>
            {f.label}
          </button>
        ))}
        <select
          value={syncWindow}
          onChange={e => setSyncWindow(e.target.value as DateWindow)}
          className="ml-auto bg-gray-900 border border-gray-700 rounded-md px-2 py-1.5 text-sm text-gray-300 focus:outline-none focus:border-blue-500"
        >
          {DATE_WINDOWS.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
        </select>
      </div>

      {loading ? (
        <div className="text-gray-500 text-sm py-8 text-center">Loading receipts…</div>
      ) : (
        <div className="rounded-lg border border-gray-800 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-900 text-gray-400 text-xs uppercase">
              <tr>
                <th className="px-4 py-2 text-left">Status</th>
                <th className="px-4 py-2 text-left">Receipt ID</th>
                <th className="hidden sm:table-cell px-4 py-2 text-right">Total</th>
                <th className="px-4 py-2 text-right">Paid</th>
                <th className="hidden md:table-cell px-4 py-2 text-left">Tracking</th>
                <th className="hidden sm:table-cell px-4 py-2 text-left">Submitted</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                    {receipts.length === 0 ? 'No receipts found.' : 'No receipts match this filter.'}
                  </td>
                </tr>
              )}
              {filtered.map(r => {
                const created = parseBgDate(r.created_dt);
                const trackingId = r.tracking?.tracking_id;
                const trackingUrl = r.tracking?.track_url;
                return (
                  <tr key={r.key ?? r.receipt_id} className="hover:bg-gray-900/40">
                    <td className="px-4 py-2">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                        r.paid ? 'bg-green-900/50 text-green-300' : 'bg-yellow-900/50 text-yellow-300'
                      }`}>
                        {r.paid ? 'Paid' : (r.status ?? 'Pending')}
                      </span>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-gray-300">{r.receipt_id ?? r.key}</td>
                    <td className="hidden sm:table-cell px-4 py-2 text-right text-gray-300">{fmt(r.total)}</td>
                    <td className="px-4 py-2 text-right text-green-400">{r.paid ? fmt(r.total_paid) : '—'}</td>
                    <td className="hidden md:table-cell px-4 py-2">
                      {trackingId ? (
                        <div className="flex flex-col gap-1">
                          {trackingUrl ? (
                            <a href={trackingUrl} target="_blank" rel="noreferrer"
                              className="text-blue-400 hover:underline font-mono text-xs">
                              {trackingId}
                            </a>
                          ) : (
                            <span className="font-mono text-xs text-gray-300">{trackingId}</span>
                          )}
                          {!r.paid && /^processing$/i.test(String(r.status ?? '')) && (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-blue-900/50 text-blue-300 w-fit">
                              Awaiting processing
                            </span>
                          )}
                        </div>
                      ) : r.paid ? '—' : (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-orange-900/50 text-orange-300">
                          No tracking
                        </span>
                      )}
                    </td>
                    <td className="hidden sm:table-cell px-4 py-2 text-gray-400 text-xs whitespace-nowrap">
                      {created ? created.toLocaleDateString() : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {pendingOrders.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wide">Submitted — Awaiting Receipt</h2>
          <div className="rounded-lg border border-orange-900/40 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-900 text-gray-400 text-xs uppercase">
                <tr>
                  <th className="px-4 py-2 text-left">Order</th>
                  <th className="px-4 py-2 text-left">Item</th>
                  <th className="px-4 py-2 text-left">Tracking</th>
                  <th className="hidden sm:table-cell px-4 py-2 text-left">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {pendingOrders.map(o => (
                  <tr key={o.id} className="hover:bg-gray-900/40">
                    <td className="px-4 py-2 font-mono text-xs text-gray-300">{o.orderNumber ?? '—'}</td>
                    <td className="px-4 py-2 text-gray-300 max-w-[200px] truncate">{o.itemDescription ?? '—'}</td>
                    <td className="px-4 py-2 font-mono text-xs text-orange-300">{o.trackingNumbers ?? '—'}</td>
                    <td className="hidden sm:table-cell px-4 py-2 text-gray-400 text-xs whitespace-nowrap">
                      {new Date(o.orderDate).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
