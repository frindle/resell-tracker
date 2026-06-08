'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { type DateWindow, DATE_WINDOWS, windowStartDate } from '@/lib/dateWindow';

type Order = {
  id: number;
  platform: string;
  orderNumber: string | null;
  orderDate: string;
  itemDescription: string | null;
  cost: number;
  shippingCost: number;
  insuranceCost: number;
  cashbackAmount: number;
  salePrice: number | null;
  salePriceSynced: boolean;
  buyer: { name: string } | null;
  card: { id: number; milesProgram: string | null; basePointsPerDollar: number | null; merchantRates: { merchant: string; pointsPerDollar: number }[] } | null;
  trackingNumbers: string | null;
  trackingSubmittedToBg: boolean;
  bgExpectedPayout: number | null;
  bgPaidAmount: number | null;
  notes: string | null;
  sourceUrl: string | null;
  bfmrReceived: boolean;
  bfmrStatus: string | null;
  overdueAt: string | null;
  lost: boolean;
};

function estimatedMiles(o: Order): number | null {
  if (!o.card?.basePointsPerDollar && !o.card?.merchantRates.length) return null;
  const rate = o.card!.merchantRates.find(r => r.merchant.toLowerCase() === o.platform.toLowerCase())?.pointsPerDollar
    ?? o.card!.basePointsPerDollar;
  if (!rate) return null;
  return Math.round((o.cost + o.shippingCost + o.insuranceCost) * rate);
}

function needsInfo(o: Order) {
  if (o.lost) return false;
  return o.salePrice == null || !o.buyer || o.cost === 0 || !o.card;
}

function paymentStatus(o: Order): 'lost' | 'paid' | 'partial' | 'overdue' | 'pending' | 'none' {
  if (o.lost) return 'lost';
  if (o.salePriceSynced) return 'paid';
  if (o.bgPaidAmount != null && o.bgPaidAmount > 0) {
    const expected = o.bgExpectedPayout ?? o.salePrice;
    if (expected == null || o.bgPaidAmount < expected - 0.01) return 'partial';
  }
  if (o.overdueAt && new Date(o.overdueAt) <= new Date()) return 'overdue';
  if (o.buyer) return 'pending';
  return 'none';
}

function profit(o: Order) {
  return (o.salePrice ?? 0) - (o.cost + o.shippingCost + o.insuranceCost - o.cashbackAmount);
}

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

const PLATFORMS = ['All', 'Amazon', 'Walmart', 'Other'];
type StatusFilter = 'all' | 'needs_info' | 'complete' | 'overdue' | 'paid' | 'partial' | 'pending';
type SortKey = 'date' | 'buyer' | 'profit' | 'cost' | 'sale';
type SortDir = 'asc' | 'desc';

function SortHeader({
  label, col, sortBy, sortDir, onSort, align = 'left', className = '',
}: {
  label: string; col: SortKey; sortBy: SortKey; sortDir: SortDir; onSort: (col: SortKey) => void; align?: 'left' | 'right'; className?: string;
}) {
  const active = sortBy === col;
  const arrow = active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';
  return (
    <th
      className={`px-4 py-2 text-${align} cursor-pointer select-none hover:text-white transition-colors ${active ? 'text-white' : 'text-gray-400'} ${className}`}
      onClick={() => onSort(col)}
    >
      {label}{arrow}
    </th>
  );
}

function OrdersPageInner() {
  const searchParams = useSearchParams();

  function loadPref<T>(key: string, fallback: T): T {
    try { const v = localStorage.getItem(`orders_${key}`); return v != null ? JSON.parse(v) as T : fallback; } catch { return fallback; }
  }
  function savePref(key: string, value: unknown) {
    try { localStorage.setItem(`orders_${key}`, JSON.stringify(value)); } catch {}
  }

  const [orders, setOrders] = useState<Order[]>([]);
  const [platform, setPlatform] = useState(() => loadPref('platform', 'All'));
  const [status, setStatus] = useState<StatusFilter>(() => (searchParams.get('status') as StatusFilter) ?? loadPref<StatusFilter>('status', 'all'));
  const [search, setSearch] = useState('');
  const [groupFilter, setGroupFilter] = useState(() => loadPref('group', 'All'));
  const [sortBy, setSortBy] = useState<SortKey>(() => loadPref<SortKey>('sortBy', 'date'));
  const [sortDir, setSortDir] = useState<SortDir>(() => loadPref<SortDir>('sortDir', 'desc'));
  const [dateWindow, setDateWindow] = useState<DateWindow>(() => loadPref<DateWindow>('dateWindow', 'all'));
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [markingPaid, setMarkingPaid] = useState(false);
  const [submittingTracking, setSubmittingTracking] = useState(false);
  const [trackingMsg, setTrackingMsg] = useState('');
  const [resyncing, setResyncing] = useState(false);
  const [resyncMsg, setResyncMsg] = useState('');
  const [changedIds, setChangedIds] = useState<Set<number>>(new Set());

  useEffect(() => { savePref('platform', platform); }, [platform]);
  useEffect(() => { savePref('status', status); }, [status]);
  useEffect(() => { savePref('group', groupFilter); }, [groupFilter]);
  useEffect(() => { savePref('sortBy', sortBy); }, [sortBy]);
  useEffect(() => { savePref('sortDir', sortDir); }, [sortDir]);
  useEffect(() => { savePref('dateWindow', dateWindow); }, [dateWindow]);

  useEffect(() => {
    fetch('/api/orders').then(r => r.json()).then(setOrders);
  }, []);

  useEffect(() => { setSelected(new Set()); }, [platform, status, search, groupFilter, sortBy]);

  function handleSort(col: SortKey) {
    if (sortBy === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(col);
      setSortDir(col === 'date' ? 'desc' : 'asc');
    }
  }

  const groups = ['All', ...Array.from(new Set(orders.map(o => o.buyer?.name ?? '').filter(Boolean))).sort()];

  const windowStart = windowStartDate(dateWindow);

  const filtered = orders.filter(o => {
    if (windowStart && new Date(o.orderDate) < windowStart) return false;
    if (platform === 'Other' && (o.platform === 'Amazon' || o.platform === 'Walmart')) return false;
    if (platform !== 'All' && platform !== 'Other' && o.platform !== platform) return false;
    if (status === 'needs_info' && !needsInfo(o)) return false;
    if (status === 'complete' && needsInfo(o)) return false;
    if (status === 'overdue' && !(o.overdueAt && new Date(o.overdueAt) <= new Date())) return false;
    if (status === 'paid' && paymentStatus(o) !== 'paid') return false;
    if (status === 'partial' && paymentStatus(o) !== 'partial') return false;
    if (status === 'pending' && paymentStatus(o) !== 'pending') return false;
    if (groupFilter !== 'All' && o.buyer?.name !== groupFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      if (
        !o.itemDescription?.toLowerCase().includes(q) &&
        !o.buyer?.name.toLowerCase().includes(q) &&
        !o.orderNumber?.toLowerCase().includes(q)
      ) return false;
    }
    return true;
  });

  // Badge counts reflect current date/platform/group/search filters but not the status filter
  const forBadges = orders.filter(o => {
    if (windowStart && new Date(o.orderDate) < windowStart) return false;
    if (platform === 'Other' && (o.platform === 'Amazon' || o.platform === 'Walmart')) return false;
    if (platform !== 'All' && platform !== 'Other' && o.platform !== platform) return false;
    if (groupFilter !== 'All' && o.buyer?.name !== groupFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      if (
        !o.itemDescription?.toLowerCase().includes(q) &&
        !o.buyer?.name.toLowerCase().includes(q) &&
        !o.orderNumber?.toLowerCase().includes(q)
      ) return false;
    }
    return true;
  });
  const needsInfoCount = forBadges.filter(needsInfo).length;
  const overdueCount = forBadges.filter(o => o.overdueAt && new Date(o.overdueAt) <= new Date()).length;
  const paidCount = forBadges.filter(o => paymentStatus(o) === 'paid').length;
  const partialCount = forBadges.filter(o => paymentStatus(o) === 'partial').length;
  const pendingCount = forBadges.filter(o => paymentStatus(o) === 'pending').length;

  const sorted = [...filtered].sort((a, b) => {
    let cmp = 0;
    if (sortBy === 'buyer') {
      cmp = (a.buyer?.name ?? 'zzz').localeCompare(b.buyer?.name ?? 'zzz');
    } else if (sortBy === 'profit') {
      cmp = profit(a) - profit(b);
    } else if (sortBy === 'cost') {
      cmp = (a.cost + a.shippingCost + a.insuranceCost) - (b.cost + b.shippingCost + b.insuranceCost);
    } else if (sortBy === 'sale') {
      cmp = (a.salePrice ?? -Infinity) - (b.salePrice ?? -Infinity);
    } else {
      cmp = new Date(a.orderDate).getTime() - new Date(b.orderDate).getTime();
    }
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const totalProfit = filtered
    .filter(o => o.salePrice != null)
    .reduce((s, o) => s + profit(o), 0);

  const outstandingValue = orders
    .filter(o => paymentStatus(o) === 'pending' && o.salePrice != null)
    .reduce((s, o) => s + (o.salePrice ?? 0), 0);

  const allSelected = sorted.length > 0 && sorted.every(o => selected.has(o.id));

  function toggleAll() {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(sorted.map(o => o.id)));
  }

  function toggleOne(id: number) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function markSelectedPaid() {
    setMarkingPaid(true);
    await Promise.all([...selected].map(id =>
      fetch(`/api/orders/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ salePriceSynced: true, overdueAt: null }),
      })
    ));
    setOrders(prev => prev.map(o => selected.has(o.id) ? { ...o, salePriceSynced: true, overdueAt: null } : o));
    setSelected(new Set());
    setMarkingPaid(false);
  }

  async function submitTrackingForSelected() {
    setSubmittingTracking(true);
    setTrackingMsg('');
    try {
      const res = await fetch('/api/orders/submit-tracking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...selected] }),
      });
      const data = await res.json();
      if (!res.ok) {
        setTrackingMsg(data.error ?? 'Failed');
      } else {
        const parts: string[] = [];
        if (data.results?.buyinggroup_count) parts.push(`BG: ${data.results.buyinggroup_count}`);
        if (data.results?.bigsky_count) parts.push(`BigSky: ${data.results.bigsky_count}`);
        if (data.errors?.buyinggroup) parts.push(`BG error: ${data.errors.buyinggroup}`);
        if (data.errors?.bigsky) parts.push(`BigSky error: ${data.errors.bigsky}`);
        setTrackingMsg(parts.join(' · ') || `Submitted ${data.submitted}`);
      }
    } catch (e) {
      setTrackingMsg(String(e));
    } finally {
      setSubmittingTracking(false);
    }
  }

  async function resyncGroups() {
    setResyncing(true);
    setResyncMsg('');
    try {
      const [bfmrRes, bgRes] = await Promise.allSettled([
        fetch('/api/bfmr/full-sync', { method: 'POST' }),
        fetch('/api/buyinggroup/sync-orders', { method: 'POST' }),
      ]);
      const parts: string[] = [];
      if (bfmrRes.status === 'fulfilled' && bfmrRes.value.ok) {
        const d = await bfmrRes.value.json();
        const created = d.created ?? 0;
        const updated = d.updated ?? 0;
        parts.push(created || updated ? `BFMR: +${created} new, ${updated} updated` : 'BFMR: no changes');
      } else {
        parts.push('BFMR: failed');
      }
      if (bgRes.status === 'fulfilled' && bgRes.value.ok) {
        const d = await bgRes.value.json();
        const bgParts: string[] = [];
        if (d.updated) bgParts.push(`${d.updated} updated`);
        if (d.reset) bgParts.push(`${d.reset} reset`);
        parts.push(`BG: ${bgParts.length ? bgParts.join(', ') : 'no changes'}`);
      } else {
        parts.push('BG: failed');
      }
      setResyncMsg(parts.join(' · '));
      // Reload orders and highlight changed rows
      const prevOrders = orders;
      const res = await fetch('/api/orders');
      if (res.ok) {
        const fresh = await res.json();
        const changed = new Set<number>();
        const prevMap = new Map(prevOrders.map((o: Order) => [o.id, o]));
        for (const o of fresh) {
          const prev = prevMap.get(o.id);
          if (prev && (prev.salePriceSynced !== o.salePriceSynced || prev.bgPaidAmount !== o.bgPaidAmount || prev.overdueAt !== o.overdueAt)) {
            changed.add(o.id);
          }
        }
        setOrders(fresh);
        if (changed.size > 0) {
          setChangedIds(changed);
          setTimeout(() => setChangedIds(new Set()), 30000);
        }
      }
    } catch (e) {
      setResyncMsg(String(e));
    } finally {
      setResyncing(false);
    }
  }

  async function deleteSelected() {
    if (!confirm(`Delete ${selected.size} order${selected.size !== 1 ? 's' : ''}? This cannot be undone.`)) return;
    setDeleting(true);
    await fetch('/api/orders/batch-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [...selected] }),
    });
    setOrders(prev => prev.filter(o => !selected.has(o.id)));
    setSelected(new Set());
    setDeleting(false);
  }

  const sharedTh = 'cursor-pointer select-none hover:text-white transition-colors';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Orders</h1>
          <p className="text-gray-400 text-sm mt-1">
            {filtered.length} orders
            {filtered.some(o => o.salePrice != null) && (
              <> · P&L: <span className={totalProfit >= 0 ? 'text-green-400' : 'text-red-400'}>{fmt(totalProfit)}</span></>
            )}
            {outstandingValue > 0 && (
              <> · Outstanding: <span className="text-yellow-400">{fmt(outstandingValue)}</span></>
            )}
          </p>
        </div>
        <div className="flex gap-2 items-center">
          {selected.size > 0 && (
            <>
              <button onClick={submitTrackingForSelected} disabled={submittingTracking}
                className="bg-blue-900/60 hover:bg-blue-900 disabled:opacity-50 text-blue-300 text-sm px-3 py-1.5 rounded-md transition-colors">
                {submittingTracking ? 'Submitting…' : 'Submit Tracking'}
              </button>
              {trackingMsg && <span className="text-xs text-gray-400">{trackingMsg}</span>}
              <button onClick={markSelectedPaid} disabled={markingPaid}
                className="bg-green-800 hover:bg-green-700 disabled:opacity-50 text-green-200 text-sm px-3 py-1.5 rounded-md transition-colors">
                {markingPaid ? 'Marking…' : `Mark ${selected.size} Paid`}
              </button>
              <button onClick={deleteSelected} disabled={deleting}
                className="bg-red-900/60 hover:bg-red-900 disabled:opacity-50 text-red-400 text-sm px-3 py-1.5 rounded-md transition-colors">
                {deleting ? 'Deleting…' : `Delete ${selected.size}`}
              </button>
            </>
          )}
          <button onClick={resyncGroups} disabled={resyncing}
            className="bg-gray-800 hover:bg-gray-700 disabled:opacity-50 border border-gray-700 text-gray-300 text-sm px-3 py-1.5 rounded-md transition-colors">
            {resyncing ? 'Syncing…' : 'Resync Groups'}
          </button>
          {resyncMsg && <span className="text-xs text-gray-400">{resyncMsg}</span>}
          <Link href="/import" className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-sm px-3 py-1.5 rounded-md transition-colors">
            Import
          </Link>
          <Link href="/orders/new" className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-3 py-1.5 rounded-md transition-colors">
            + New Order
          </Link>
        </div>
      </div>

      <div className="flex gap-3 flex-wrap items-center">
        <input
          type="text"
          placeholder="Search item, buyer, order #…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="bg-gray-900 border border-gray-700 rounded-md px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 w-64"
        />

        {/* Status filter */}
        <div className="flex gap-1">
          <button onClick={() => setStatus('all')}
            className={`px-3 py-1.5 rounded-md text-sm transition-colors ${status === 'all' ? 'bg-blue-600 text-white' : 'bg-gray-900 border border-gray-700 text-gray-400 hover:text-white'}`}>
            All
          </button>
          <button onClick={() => setStatus('needs_info')}
            className={`px-3 py-1.5 rounded-md text-sm transition-colors flex items-center gap-1.5 ${status === 'needs_info' ? 'bg-yellow-600 text-white' : 'bg-gray-900 border border-gray-700 text-gray-400 hover:text-white'}`}>
            Needs Info
            {needsInfoCount > 0 && (
              <span className={`text-xs rounded-full px-1.5 py-0.5 font-medium ${status === 'needs_info' ? 'bg-yellow-500 text-white' : 'bg-yellow-900/60 text-yellow-400'}`}>
                {needsInfoCount}
              </span>
            )}
          </button>
          <button onClick={() => setStatus('overdue')}
            className={`px-3 py-1.5 rounded-md text-sm transition-colors flex items-center gap-1.5 ${status === 'overdue' ? 'bg-red-700 text-white' : 'bg-gray-900 border border-gray-700 text-gray-400 hover:text-white'}`}>
            Overdue
            {overdueCount > 0 && (
              <span className={`text-xs rounded-full px-1.5 py-0.5 font-medium ${status === 'overdue' ? 'bg-red-500 text-white' : 'bg-red-900/60 text-red-400'}`}>
                {overdueCount}
              </span>
            )}
          </button>
          <button onClick={() => setStatus('paid')}
            className={`px-3 py-1.5 rounded-md text-sm transition-colors flex items-center gap-1.5 ${status === 'paid' ? 'bg-green-700 text-white' : 'bg-gray-900 border border-gray-700 text-gray-400 hover:text-white'}`}>
            Paid
            {paidCount > 0 && (
              <span className={`text-xs rounded-full px-1.5 py-0.5 font-medium ${status === 'paid' ? 'bg-green-500 text-white' : 'bg-green-900/60 text-green-400'}`}>
                {paidCount}
              </span>
            )}
          </button>
          <button onClick={() => setStatus('partial')}
            className={`px-3 py-1.5 rounded-md text-sm transition-colors flex items-center gap-1.5 ${status === 'partial' ? 'bg-blue-700 text-white' : 'bg-gray-900 border border-gray-700 text-gray-400 hover:text-white'}`}>
            Partial
            {partialCount > 0 && (
              <span className={`text-xs rounded-full px-1.5 py-0.5 font-medium ${status === 'partial' ? 'bg-blue-500 text-white' : 'bg-blue-900/60 text-blue-400'}`}>
                {partialCount}
              </span>
            )}
          </button>
          <button onClick={() => setStatus('pending')}
            className={`px-3 py-1.5 rounded-md text-sm transition-colors flex items-center gap-1.5 ${status === 'pending' ? 'bg-yellow-700 text-white' : 'bg-gray-900 border border-gray-700 text-gray-400 hover:text-white'}`}>
            Pending
            {pendingCount > 0 && (
              <span className={`text-xs rounded-full px-1.5 py-0.5 font-medium ${status === 'pending' ? 'bg-yellow-500 text-white' : 'bg-yellow-900/60 text-yellow-400'}`}>
                {pendingCount}
              </span>
            )}
          </button>
        </div>

        {/* Platform filter */}
        <div className="flex gap-1">
          {PLATFORMS.map(p => (
            <button key={p} onClick={() => setPlatform(p)}
              className={`px-3 py-1.5 rounded-md text-sm transition-colors ${platform === p ? 'bg-gray-600 text-white' : 'bg-gray-900 border border-gray-700 text-gray-400 hover:text-white'}`}>
              {p}
            </button>
          ))}
        </div>

        {/* Group filter */}
        {groups.length > 1 && (
          <select
            value={groupFilter}
            onChange={e => setGroupFilter(e.target.value)}
            className="bg-gray-900 border border-gray-700 rounded-md px-3 py-1.5 text-sm text-gray-300 focus:outline-none focus:border-blue-500"
          >
            {groups.map(g => (
              <option key={g} value={g}>{g === 'All' ? 'All Groups' : g}</option>
            ))}
          </select>
        )}

        {/* Date window */}
        <select
          value={dateWindow}
          onChange={e => setDateWindow(e.target.value as DateWindow)}
          className="ml-auto bg-gray-900 border border-gray-700 rounded-md px-2 py-1.5 text-sm text-gray-300 focus:outline-none focus:border-blue-500"
        >
          {DATE_WINDOWS.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
        </select>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-700 py-12 text-center text-gray-500">
          {status === 'needs_info' ? 'All orders are complete.' : 'No orders found.'}
        </div>
      ) : (
        <div className="rounded-lg border border-gray-800 overflow-x-auto">
          <table className="w-full text-sm table-fixed">
            <thead className="bg-gray-900 text-gray-400 text-xs uppercase">
              <tr>
                <th className="px-3 py-2 w-8">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} className="accent-blue-500" />
                </th>
                <SortHeader label="Date" col="date" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} className="w-[88px]" />
                <th className="px-4 py-2 text-left text-gray-400">Item</th>
                <th className="hidden sm:table-cell px-4 py-2 text-left text-gray-400 w-20">Platform</th>
                <SortHeader label="Group" col="buyer" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} className="w-32" />
                <th className="px-4 py-2 text-left text-gray-400 w-[90px]">Status</th>
                <SortHeader label="Cost" col="cost" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} align="right" className="w-20" />
                <th className="hidden lg:table-cell px-4 py-2 text-right text-gray-400 w-20">Cashback</th>
                <th className="hidden lg:table-cell px-4 py-2 text-right text-gray-400 w-24">Miles</th>
                <SortHeader label="Sale" col="sale" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} align="right" className="w-20" />
                <SortHeader label="P&L" col="profit" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} align="right" className="w-24" />
                <th className="px-3 py-2 w-12"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {sorted.map(o => {
                const incomplete = needsInfo(o);
                const p = profit(o);
                const isSelected = selected.has(o.id);
                return (
                  <tr key={o.id} className={`hover:bg-gray-900/50 ${incomplete ? 'opacity-75' : ''} ${changedIds.has(o.id) ? 'bg-yellow-950/40' : isSelected ? 'bg-blue-950/30' : ''} ${o.overdueAt && new Date(o.overdueAt) <= new Date() ? 'border-l-2 border-red-600' : o.salePriceSynced ? 'border-l-2 border-green-700' : ''}`}>
                    <td className="px-3 py-3">
                      <input type="checkbox" checked={isSelected} onChange={() => toggleOne(o.id)} className="accent-blue-500" />
                    </td>
                    <td className="px-4 py-3 text-gray-400 whitespace-nowrap">{o.orderDate.slice(0, 10)}</td>
                    <td className="px-4 py-3 overflow-hidden">
                      <Link href={`/orders/${o.id}?from=${encodeURIComponent(`/orders?status=${status}`)}`} className="hover:text-blue-400 transition-colors truncate block">
                        {o.itemDescription || '—'}
                      </Link>
                      {o.orderNumber && (
                        o.sourceUrl
                          ? <a href={o.sourceUrl} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline text-xs font-mono">#{o.orderNumber}</a>
                          : <span className="text-gray-500 text-xs font-mono">#{o.orderNumber}</span>
                      )}
                    </td>
                    <td className="hidden sm:table-cell px-4 py-3 text-gray-400">{o.platform}</td>
                    <td className="px-4 py-3 overflow-hidden">
                      {o.buyer?.name
                        ? <div className="flex flex-col gap-0.5">
                            <span className="text-gray-400 truncate block">{o.buyer.name}</span>
                            {!o.salePriceSynced && /buyinggroup/i.test(o.buyer.name) && o.trackingNumbers && !o.trackingSubmittedToBg && (
                              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-orange-900/50 text-orange-300 w-fit">
                                BG Missing Tracking
                              </span>
                            )}
                            {!o.salePriceSynced && /buyinggroup|bigsky|bfmr/i.test(o.buyer.name) && !o.trackingNumbers && (
                              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-red-900/50 text-red-300 w-fit">
                                No tracking
                              </span>
                            )}
                          </div>
                        : <span className="text-yellow-600 text-xs">no buyer</span>}
                    </td>
                    <td className="px-4 py-3">
                      {(() => {
                        const ps = paymentStatus(o);
                        if (ps === 'lost') return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-800 text-gray-400">Lost</span>;
                        if (ps === 'paid') return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-900/50 text-green-300">Paid</span>;
                        if (ps === 'partial') return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-900/50 text-blue-300">Partial {o.bgPaidAmount != null ? fmt(o.bgPaidAmount) : ''}</span>;
                        if (o.bfmrStatus === 'processed') return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-900/50 text-blue-300">Processed</span>;
                        if (o.bfmrStatus === 'received' || o.bfmrStatus === 'pkg_received' || (o.bfmrReceived && !o.bfmrStatus)) return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-orange-900/50 text-orange-300">Received</span>;
                        if (ps === 'overdue') return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-900/50 text-red-300">Overdue</span>;
                        if (ps === 'pending') return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-yellow-900/50 text-yellow-300">Pending</span>;
                        return <span className="text-gray-600 text-xs">—</span>;
                      })()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {o.cost === 0
                        ? <span className="text-yellow-600 text-xs">needed</span>
                        : <span className="text-gray-400">{fmt(o.cost + o.shippingCost + o.insuranceCost)}</span>}
                    </td>
                    <td className="hidden lg:table-cell px-4 py-3 text-right text-green-400/70">{o.cashbackAmount > 0 ? fmt(o.cashbackAmount) : '—'}</td>
                    <td className="hidden lg:table-cell px-4 py-3 text-right text-blue-400/70">{(() => { const m = estimatedMiles(o); if (!m) return '—'; const prog = o.card?.milesProgram; return prog ? `${m.toLocaleString()} ${prog}` : m.toLocaleString(); })()}</td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      {o.salePrice != null
                        ? fmt(o.salePrice)
                        : <span className="text-yellow-600 text-xs">needed</span>}
                    </td>
                    <td className="px-4 py-3 text-right font-medium whitespace-nowrap">
                      {o.salePrice != null
                        ? <span className={p >= 0 ? 'text-green-400' : 'text-red-400'}>{fmt(p)}</span>
                        : <span className="text-gray-600">—</span>}
                    </td>
                    <td className="px-3 py-3 text-right">
                      <Link href={`/orders/${o.id}?from=${encodeURIComponent(`/orders?status=${status}`)}`}
                        className={`text-xs transition-colors ${incomplete ? 'text-yellow-600 hover:text-yellow-400' : 'text-gray-500 hover:text-white'}`}>
                        {incomplete ? 'Fill in →' : 'Edit'}
                      </Link>
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

export default function OrdersPage() {
  return <Suspense><OrdersPageInner /></Suspense>;
}
