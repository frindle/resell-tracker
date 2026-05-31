'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';

type Order = {
  id: number;
  platform: string;
  orderNumber: string | null;
  orderDate: string;
  itemDescription: string | null;
  cost: number;
  shippingCost: number;
  cashbackAmount: number;
  salePrice: number | null;
  buyer: { name: string } | null;
  card: { id: number; basePointsPerDollar: number | null; merchantRates: { merchant: string; pointsPerDollar: number }[] } | null;
  notes: string | null;
  sourceUrl: string | null;
  overdueAt: string | null;
};

function estimatedMiles(o: Order): number | null {
  if (!o.card?.basePointsPerDollar && !o.card?.merchantRates.length) return null;
  const rate = o.card!.merchantRates.find(r => r.merchant.toLowerCase() === o.platform.toLowerCase())?.pointsPerDollar
    ?? o.card!.basePointsPerDollar;
  if (!rate) return null;
  return Math.round((o.cost + o.shippingCost) * rate);
}

function needsInfo(o: Order) {
  return o.salePrice == null || !o.buyer || o.cost === 0 || !o.card;
}

function profit(o: Order) {
  return (o.salePrice ?? 0) - (o.cost + o.shippingCost - o.cashbackAmount);
}

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

const PLATFORMS = ['All', 'Amazon', 'Walmart', 'Other'];
type StatusFilter = 'all' | 'needs_info' | 'complete' | 'overdue';
type SortKey = 'date' | 'buyer' | 'profit' | 'cost' | 'sale';
type SortDir = 'asc' | 'desc';

function SortHeader({
  label, col, sortBy, sortDir, onSort, align = 'left',
}: {
  label: string; col: SortKey; sortBy: SortKey; sortDir: SortDir; onSort: (col: SortKey) => void; align?: 'left' | 'right';
}) {
  const active = sortBy === col;
  const arrow = active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';
  return (
    <th
      className={`px-4 py-2 text-${align} cursor-pointer select-none hover:text-white transition-colors ${active ? 'text-white' : 'text-gray-400'}`}
      onClick={() => onSort(col)}
    >
      {label}{arrow}
    </th>
  );
}

function OrdersPageInner() {
  const searchParams = useSearchParams();
  const [orders, setOrders] = useState<Order[]>([]);
  const [platform, setPlatform] = useState('All');
  const [status, setStatus] = useState<StatusFilter>((searchParams.get('status') as StatusFilter) ?? 'all');
  const [search, setSearch] = useState('');
  const [groupFilter, setGroupFilter] = useState('All');
  const [sortBy, setSortBy] = useState<SortKey>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [deleting, setDeleting] = useState(false);

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

  const needsInfoCount = orders.filter(needsInfo).length;
  const overdueCount = orders.filter(o => o.overdueAt).length;

  const filtered = orders.filter(o => {
    if (platform !== 'All' && o.platform !== platform) return false;
    if (status === 'needs_info' && !needsInfo(o)) return false;
    if (status === 'complete' && needsInfo(o)) return false;
    if (status === 'overdue' && !o.overdueAt) return false;
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

  const sorted = [...filtered].sort((a, b) => {
    let cmp = 0;
    if (sortBy === 'buyer') {
      cmp = (a.buyer?.name ?? 'zzz').localeCompare(b.buyer?.name ?? 'zzz');
    } else if (sortBy === 'profit') {
      cmp = profit(a) - profit(b);
    } else if (sortBy === 'cost') {
      cmp = (a.cost + a.shippingCost) - (b.cost + b.shippingCost);
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
          </p>
        </div>
        <div className="flex gap-2 items-center">
          {selected.size > 0 && (
            <button onClick={deleteSelected} disabled={deleting}
              className="bg-red-900/60 hover:bg-red-900 disabled:opacity-50 text-red-400 text-sm px-3 py-1.5 rounded-md transition-colors">
              {deleting ? 'Deleting…' : `Delete ${selected.size}`}
            </button>
          )}
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
          <button onClick={() => setStatus('complete')}
            className={`px-3 py-1.5 rounded-md text-sm transition-colors ${status === 'complete' ? 'bg-green-700 text-white' : 'bg-gray-900 border border-gray-700 text-gray-400 hover:text-white'}`}>
            Complete
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
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-700 py-12 text-center text-gray-500">
          {status === 'needs_info' ? 'All orders are complete.' : 'No orders found.'}
        </div>
      ) : (
        <div className="rounded-lg border border-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-900 text-gray-400 text-xs uppercase">
              <tr>
                <th className="px-3 py-2 w-8">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} className="accent-blue-500" />
                </th>
                <SortHeader label="Date" col="date" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                <th className="px-4 py-2 text-left text-gray-400">Item</th>
                <th className="px-4 py-2 text-left text-gray-400">Platform</th>
                <SortHeader label="Group" col="buyer" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                <SortHeader label="Cost" col="cost" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} align="right" />
                <th className="px-4 py-2 text-right text-gray-400">Cashback</th>
                <th className="px-4 py-2 text-right text-gray-400">Miles</th>
                <SortHeader label="Sale" col="sale" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} align="right" />
                <SortHeader label="P&L" col="profit" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} align="right" />
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {sorted.map(o => {
                const incomplete = needsInfo(o);
                const p = profit(o);
                const isSelected = selected.has(o.id);
                return (
                  <tr key={o.id} className={`hover:bg-gray-900/50 ${incomplete ? 'opacity-75' : ''} ${isSelected ? 'bg-blue-950/30' : ''} ${o.overdueAt ? 'border-l-2 border-red-600' : ''}`}>
                    <td className="px-3 py-3">
                      <input type="checkbox" checked={isSelected} onChange={() => toggleOne(o.id)} className="accent-blue-500" />
                    </td>
                    <td className="px-4 py-3 text-gray-400 whitespace-nowrap">{o.orderDate.slice(0, 10)}</td>
                    <td className="px-4 py-3 max-w-[200px]">
                      <Link href={`/orders/${o.id}?from=${encodeURIComponent(`/orders?status=${status}`)}`} className="hover:text-blue-400 transition-colors truncate block">
                        {o.itemDescription || '—'}
                      </Link>
                      {o.orderNumber && (
                        o.sourceUrl
                          ? <a href={o.sourceUrl} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline text-xs font-mono">#{o.orderNumber}</a>
                          : <span className="text-gray-500 text-xs font-mono">#{o.orderNumber}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-400">{o.platform}</td>
                    <td className="px-4 py-3">
                      {o.buyer?.name
                        ? <span className="text-gray-400">{o.buyer.name}</span>
                        : <span className="text-yellow-600 text-xs">no buyer</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {o.cost === 0
                        ? <span className="text-yellow-600 text-xs">needed</span>
                        : <span className="text-gray-400">{fmt(o.cost + o.shippingCost)}</span>}
                    </td>
                    <td className="px-4 py-3 text-right text-green-400/70">{o.cashbackAmount > 0 ? fmt(o.cashbackAmount) : '—'}</td>
                    <td className="px-4 py-3 text-right text-blue-400/70">{(() => { const m = estimatedMiles(o); return m ? m.toLocaleString() : '—'; })()}</td>
                    <td className="px-4 py-3 text-right">
                      {o.salePrice != null
                        ? fmt(o.salePrice)
                        : <span className="text-yellow-600 text-xs">needed</span>}
                    </td>
                    <td className="px-4 py-3 text-right font-medium">
                      {o.salePrice != null
                        ? <span className={p >= 0 ? 'text-green-400' : 'text-red-400'}>{fmt(p)}</span>
                        : <span className="text-gray-600">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
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
