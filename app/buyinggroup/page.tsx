'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

type Receipt = {
  id: number;
  order_number: string;
  store_name?: string;
  status?: string;
  total_amount?: string | number;
  cashback_amount?: string | number;
  created_at?: string;
  payment_date?: string;
  tracking_number?: string;
  tracking_url?: string;
  [key: string]: unknown;
};

const STATUS_BADGE: Record<string, string> = {
  paid:          'bg-green-900/50 text-green-300',
  payment_error: 'bg-red-900/50 text-red-300',
  shipped:       'bg-blue-900/50 text-blue-300',
  delivered:     'bg-cyan-900/50 text-cyan-300',
  pending:       'bg-yellow-900/50 text-yellow-300',
  cancelled:     'bg-gray-800 text-gray-500',
  returned:      'bg-red-900/50 text-red-300',
};

function fmt(v: string | number | undefined) {
  const n = parseFloat(String(v ?? 0));
  if (isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

type Filter = 'all' | 'pending' | 'shipped' | 'paid' | 'error';
type SyncWindow = '3m' | '6m' | '1y' | 'all';

const WINDOWS: { value: SyncWindow; label: string }[] = [
  { value: '3m', label: 'Last 3 months' },
  { value: '6m', label: 'Last 6 months' },
  { value: '1y', label: 'Last year' },
  { value: 'all', label: 'All time' },
];

export default function BuyingGroupPage() {
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [syncWindow, setSyncWindow] = useState<SyncWindow>('3m');

  useEffect(() => {
    fetch('/api/buyinggroup/receipts')
      .then(r => {
        if (r.status === 400) throw new Error('not_configured');
        if (!r.ok) throw new Error(`API error ${r.status}`);
        return r.json();
      })
      .then(data => {
        const items: Receipt[] = Array.isArray(data) ? data : (data.results ?? data.data ?? []);
        setReceipts(items);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const sinceMs = (() => {
    if (syncWindow === 'all') return 0;
    const d = new Date();
    if (syncWindow === '3m') d.setMonth(d.getMonth() - 3);
    if (syncWindow === '6m') d.setMonth(d.getMonth() - 6);
    if (syncWindow === '1y') d.setFullYear(d.getFullYear() - 1);
    return d.getTime();
  })();

  const filtered = receipts.filter(r => {
    if (sinceMs && r.created_at && new Date(String(r.created_at)).getTime() < sinceMs) return false;
    const s = String(r.status ?? '').toLowerCase();
    if (filter === 'pending') return s.includes('pending') || s.includes('processing') || s.includes('ordered');
    if (filter === 'shipped') return s.includes('ship') || s.includes('deliver');
    if (filter === 'paid')    return s.includes('paid') || s.includes('payment_complete');
    if (filter === 'error')   return s.includes('error') || s.includes('return') || s.includes('cancel');
    return true;
  });

  const totalPaid = filter === 'paid'
    ? filtered.reduce((sum, r) => sum + parseFloat(String(r.cashback_amount ?? 0)), 0)
    : 0;

  const FILTERS: { key: Filter; label: string }[] = [
    { key: 'all',     label: 'All' },
    { key: 'pending', label: 'Pending' },
    { key: 'shipped', label: 'Shipped' },
    { key: 'paid',    label: 'Paid' },
    { key: 'error',   label: 'Issues' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">BuyingGroup Receipts</h1>
          <p className="text-gray-400 text-sm mt-0.5">Orders submitted through BuyingGroup.com</p>
        </div>
        <Link href="/buyinggroup/deals"
          className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-sm px-4 py-2 rounded-md transition-colors">
          Browse Deals →
        </Link>
      </div>

      {error === 'not_configured' ? (
        <div className="rounded-lg border border-yellow-800 bg-yellow-900/20 px-4 py-3 text-sm text-yellow-300">
          BuyingGroup not configured.{' '}
          <Link href="/settings" className="underline hover:text-yellow-200">Add credentials in Settings</Link>
        </div>
      ) : error ? (
        <div className="rounded-lg border border-red-800 bg-red-900/20 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      ) : null}

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
          onChange={e => setSyncWindow(e.target.value as SyncWindow)}
          className="ml-auto bg-gray-900 border border-gray-700 rounded-md px-2 py-1.5 text-sm text-gray-300 focus:outline-none focus:border-blue-500"
        >
          {WINDOWS.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
        </select>
        {filter === 'paid' && totalPaid > 0 && (
          <span className="text-green-400 text-sm self-center font-medium">
            Total cashback: {fmt(totalPaid)}
          </span>
        )}
      </div>

      {loading ? (
        <div className="text-gray-500 text-sm py-8 text-center">Loading receipts…</div>
      ) : (
        <div className="rounded-lg border border-gray-800 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-900 text-gray-400 text-xs uppercase">
              <tr>
                <th className="px-4 py-2 text-left">Status</th>
                <th className="px-4 py-2 text-left">Order #</th>
                <th className="px-4 py-2 text-left">Store</th>
                <th className="px-4 py-2 text-right">Total</th>
                <th className="px-4 py-2 text-right">Cashback</th>
                <th className="px-4 py-2 text-left">Tracking</th>
                <th className="px-4 py-2 text-left">Date</th>
                <th className="px-4 py-2 text-left">Paid</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-gray-500">
                    {receipts.length === 0 ? 'No receipts found.' : 'No receipts match this filter.'}
                  </td>
                </tr>
              )}
              {filtered.map(r => {
                const status = String(r.status ?? '').toLowerCase();
                const badgeClass = Object.entries(STATUS_BADGE).find(([k]) => status.includes(k))?.[1]
                  ?? 'bg-gray-800 text-gray-400';
                return (
                  <tr key={r.id} className="hover:bg-gray-900/40">
                    <td className="px-4 py-2">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${badgeClass}`}>
                        {r.status ?? '—'}
                      </span>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-gray-300">{r.order_number || '—'}</td>
                    <td className="px-4 py-2 text-gray-300">{String(r.store_name ?? '—')}</td>
                    <td className="px-4 py-2 text-right text-gray-300">{fmt(r.total_amount)}</td>
                    <td className="px-4 py-2 text-right text-green-400">{fmt(r.cashback_amount)}</td>
                    <td className="px-4 py-2">
                      {r.tracking_number ? (
                        r.tracking_url ? (
                          <a href={String(r.tracking_url)} target="_blank" rel="noreferrer"
                            className="text-blue-400 hover:underline font-mono text-xs">
                            {String(r.tracking_number)}
                          </a>
                        ) : (
                          <span className="font-mono text-xs text-gray-300">{String(r.tracking_number)}</span>
                        )
                      ) : '—'}
                    </td>
                    <td className="px-4 py-2 text-gray-400 text-xs whitespace-nowrap">
                      {r.created_at ? new Date(String(r.created_at)).toLocaleDateString() : '—'}
                    </td>
                    <td className="px-4 py-2 text-gray-400 text-xs whitespace-nowrap">
                      {r.payment_date ? new Date(String(r.payment_date)).toLocaleDateString() : '—'}
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
