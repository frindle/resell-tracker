'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { type DateWindow, DATE_WINDOWS, windowStartDate } from '@/lib/dateWindow';

type BGOrder = {
  key: string;
  order_id: string;
  tracking_id?: string;
  status: string;
  carrier?: string;
  verified: boolean;
  amount?: string;
  tracking?: { tracking_id?: string; track_url?: string };
  created_dt?: string;
  [key: string]: unknown;
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
  const [creditedReceiptIds, setCreditedReceiptIds] = useState<Set<string>>(new Set());
  const [bgOrders, setBgOrders] = useState<BGOrder[]>([]);
  const [resolvedIds, setResolvedIds] = useState<Set<string>>(new Set());
  const [showResolved, setShowResolved] = useState(false);
  const [payoutMap, setPayoutMap] = useState<Record<string, number>>({});
  const [trackingOrders, setTrackingOrders] = useState<Record<string, { id: number; itemDescription: string | null; salePrice: number | null; bgExpectedPayout: number | null }[]>>({});
  const [expandedTracking, setExpandedTracking] = useState<string | null>(null);
  const [editingExpected, setEditingExpected] = useState<Record<number, string>>({});
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
      fetch('/api/buyinggroup/orders').then(r => r.ok ? r.json() : []),
      fetch('/api/buyinggroup/resolve-order').then(r => r.ok ? r.json() : []),
      fetch('/api/buyinggroup/order-payouts').then(r => r.ok ? r.json() : {}),
      fetch('/api/buyinggroup/tracking-orders').then(r => r.ok ? r.json() : {}),
    ])
      .then(([data, pending, resolved, payouts, trkOrders]) => {
        const items: Receipt[] = (data?.receipts ?? []) as Receipt[];
        const requestedTotal: number = data?.requested_total ?? 0;

        // Receipts are "credited only" (not yet disbursed) if their amounts fall within
        // the total of REQUESTED payments — walk newest-first up to that amount.
        const paidSorted = [...items]
          .filter(r => r.paid)
          .sort((a, b) => new Date(String(b.modified_dt ?? b.created_dt ?? 0)).getTime() - new Date(String(a.modified_dt ?? a.created_dt ?? 0)).getTime());
        let accumulatedCents = 0;
        const requestedCents = Math.round(requestedTotal * 100);
        const credited = new Set<string>();
        for (const r of paidSorted) {
          if (accumulatedCents >= requestedCents) break;
          const amt = parseFloat(String(r.total_paid ?? r.total ?? 0)) || 0;
          const amtCents = Math.round(amt * 100);
          if (accumulatedCents + amtCents <= requestedCents + 1) {
            credited.add(r.receipt_id);
            accumulatedCents += amtCents;
          } else {
            break;
          }
        }
        setCreditedReceiptIds(credited);
        setReceipts(items);
        setBgOrders(pending as BGOrder[]);
        setResolvedIds(new Set(resolved as string[]));
        setPayoutMap(payouts as Record<string, number>);
        setTrackingOrders(trkOrders as typeof trackingOrders);
        fetch('/api/buyinggroup/sync-orders', { method: 'POST' }).catch(() => {});
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  async function saveExpectedPayout(orderId: number, value: string) {
    const amount = parseFloat(value);
    const patch = isNaN(amount) ? { bgExpectedPayout: null } : { bgExpectedPayout: amount };
    await fetch(`/api/orders/${orderId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    // Refresh payout map and tracking orders
    const [payouts, trkOrders] = await Promise.all([
      fetch('/api/buyinggroup/order-payouts').then(r => r.json()),
      fetch('/api/buyinggroup/tracking-orders').then(r => r.json()),
    ]);
    setPayoutMap(payouts as Record<string, number>);
    setTrackingOrders(trkOrders as typeof trackingOrders);
  }

  async function resolveOrder(orderId: string) {
    await fetch('/api/buyinggroup/resolve-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId }),
    });
    setResolvedIds(prev => new Set([...prev, orderId]));
  }

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

  // A receipt is "truly paid out" if paid=true AND not just sitting in the credited balance
  function isTrulyPaid(r: Receipt) { return r.paid && !creditedReceiptIds.has(r.receipt_id); }

  const filtered = receipts.filter(r => {
    const created = parseBgDate(r.created_dt);
    if (sinceMs && created && created.getTime() < sinceMs) return false;
    if (filter === 'paid') return isTrulyPaid(r);
    if (filter === 'unpaid') return !isTrulyPaid(r);
    return true;
  });

  const totalPaid = receipts.filter(r => isTrulyPaid(r)).reduce((sum, r) => sum + parseFloat(String(r.total_paid ?? r.total ?? 0)), 0);

  // Sum BG receipt totals per order (via tracking number) to compare against our salePrice
  const bgTotalByTracking: Record<string, number> = {};
  for (const r of receipts) {
    const t = (r.tracking?.tracking_id ?? '').replace(/\D/g, '');
    if (!t) continue;
    bgTotalByTracking[t] = (bgTotalByTracking[t] ?? 0) + parseFloat(String(r.total ?? 0));
  }

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
                const normTracking = (trackingId ?? '').replace(/\D/g, '');
                const ourPayout = normTracking ? payoutMap[normTracking] : undefined;
                const bgOrderTotal = normTracking ? (bgTotalByTracking[normTracking] ?? 0) : 0;
                const trulyPaid = isTrulyPaid(r);
                const payoutShort = trulyPaid && ourPayout != null && bgOrderTotal > 0 && (ourPayout - bgOrderTotal) > 5;
                const ordersForTracking = normTracking ? (trackingOrders[normTracking] ?? []) : [];
                const isExpanded = expandedTracking === normTracking;
                return (
                  <React.Fragment key={r.key ?? r.receipt_id}>
                  <tr className="hover:bg-gray-900/40">
                    <td className="px-4 py-2">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                        trulyPaid ? 'bg-green-900/50 text-green-300' : r.paid ? 'bg-blue-900/50 text-blue-300' : 'bg-yellow-900/50 text-yellow-300'
                      }`}>
                        {trulyPaid ? 'Paid' : r.paid ? 'Credited' : (r.status ?? 'Pending')}
                      </span>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-gray-300">{r.receipt_id ?? r.key}</td>
                    <td className="hidden sm:table-cell px-4 py-2 text-right">
                      <div className="flex flex-col items-end gap-0.5">
                        <span className="text-gray-300">{fmt(r.total)}</span>
                        {payoutShort && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-red-900/50 text-red-300 whitespace-nowrap">
                            Short {fmt(ourPayout! - bgOrderTotal)}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2 text-right text-green-400">{r.paid ? fmt(r.total_paid) : '—'}</td>
                    <td className="hidden md:table-cell px-4 py-2">
                      {trackingId ? (
                        <div className="flex flex-col gap-1">
                          <div className="flex items-center gap-2">
                            {trackingUrl ? (
                              <a href={trackingUrl} target="_blank" rel="noreferrer"
                                className="text-blue-400 hover:underline font-mono text-xs">
                                {trackingId}
                              </a>
                            ) : (
                              <span className="font-mono text-xs text-gray-300">{trackingId}</span>
                            )}
                            {ordersForTracking.length > 1 && (
                              <button
                                onClick={() => setExpandedTracking(isExpanded ? null : normTracking)}
                                className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
                              >
                                {isExpanded ? 'hide split' : `split (${ordersForTracking.length})`}
                              </button>
                            )}
                          </div>
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
                  {isExpanded && ordersForTracking.length > 0 && (
                    <tr key={`${r.key ?? r.receipt_id}-split`} className="bg-gray-900/60">
                      <td colSpan={6} className="px-6 py-3">
                        <div className="space-y-2">
                          <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Expected payout per order</p>
                          {ordersForTracking.map(o => (
                            <div key={o.id} className="flex items-center gap-3">
                              <span className="text-xs text-gray-400 flex-1 truncate">{o.itemDescription ?? `Order #${o.id}`}</span>
                              <span className="text-xs text-gray-600">sale: {o.salePrice != null ? fmt(o.salePrice) : '—'}</span>
                              <input
                                type="number"
                                step="0.01"
                                placeholder={o.salePrice != null ? String(o.salePrice) : '0.00'}
                                value={editingExpected[o.id] ?? (o.bgExpectedPayout != null ? String(o.bgExpectedPayout) : '')}
                                onChange={e => setEditingExpected(prev => ({ ...prev, [o.id]: e.target.value }))}
                                onBlur={async e => {
                                  await saveExpectedPayout(o.id, e.target.value);
                                }}
                                className="w-24 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
                              />
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {bgOrders.filter(o => !o.verified).length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wide">In Progress</h2>
            {bgOrders.filter(o => !o.verified && resolvedIds.has(o.order_id)).length > 0 && (
              <button onClick={() => setShowResolved(v => !v)} className="text-xs text-gray-500 hover:text-gray-300">
                {showResolved ? 'Hide resolved' : `Show ${bgOrders.filter(o => !o.verified && resolvedIds.has(o.order_id)).length} resolved`}
              </button>
            )}
          </div>
          <div className="rounded-lg border border-gray-700 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-900 text-gray-400 text-xs uppercase">
                <tr>
                  <th className="px-4 py-2 text-left">Status</th>
                  <th className="px-4 py-2 text-left">Order ID</th>
                  <th className="px-4 py-2 text-left">Carrier</th>
                  <th className="px-4 py-2 text-left">Tracking</th>
                  <th className="hidden sm:table-cell px-4 py-2 text-left">Date</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {bgOrders.filter(o => !o.verified && (showResolved || !resolvedIds.has(o.order_id))).map(o => {
                  const trackingId = o.tracking?.tracking_id ?? o.tracking_id;
                  const trackingUrl = o.tracking?.track_url;
                  return (
                    <tr key={o.key} className="hover:bg-gray-900/40">
                      <td className="px-4 py-2">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                          o.status === 'PROCESSING' ? 'bg-blue-900/50 text-blue-300' : 'bg-yellow-900/50 text-yellow-300'
                        }`}>
                          {o.status}
                        </span>
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-gray-300">{o.order_id}</td>
                      <td className="px-4 py-2 text-gray-400 text-xs">{o.carrier ?? '—'}</td>
                      <td className="px-4 py-2 font-mono text-xs">
                        {trackingId ? (
                          trackingUrl ? (
                            <a href={trackingUrl} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">{trackingId}</a>
                          ) : (
                            <span className="text-gray-300">{trackingId}</span>
                          )
                        ) : '—'}
                      </td>
                      <td className="hidden sm:table-cell px-4 py-2 text-gray-400 text-xs whitespace-nowrap">
                        {o.created_dt ? o.created_dt.split(',')[0] : '—'}
                      </td>
                      <td className="px-4 py-2 text-right">
                        {o.status === 'RECEIVED WITH ISSUES' && !resolvedIds.has(o.order_id) && (
                          <button onClick={() => resolveOrder(o.order_id)}
                            className="text-xs bg-gray-700 hover:bg-gray-600 px-2 py-1 rounded transition-colors text-gray-300">
                            Mark Resolved
                          </button>
                        )}
                        {resolvedIds.has(o.order_id) && (
                          <span className="text-xs text-gray-600">Resolved</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
