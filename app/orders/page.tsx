'use client';

import { useEffect, useState } from 'react';
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
  notes: string | null;
  sourceUrl: string | null;
};

function needsInfo(o: Order) {
  return o.salePrice == null || !o.buyer;
}

function profit(o: Order) {
  return (o.salePrice ?? 0) - (o.cost + o.shippingCost - o.cashbackAmount);
}

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

const PLATFORMS = ['All', 'Amazon', 'Walmart', 'Other'];
type StatusFilter = 'all' | 'needs_info' | 'complete';

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [platform, setPlatform] = useState('All');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');

  useEffect(() => {
    fetch('/api/orders').then(r => r.json()).then(setOrders);
  }, []);

  const needsInfoCount = orders.filter(needsInfo).length;

  const filtered = orders.filter(o => {
    if (platform !== 'All' && o.platform !== platform) return false;
    if (status === 'needs_info' && !needsInfo(o)) return false;
    if (status === 'complete' && needsInfo(o)) return false;
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

  const totalProfit = filtered
    .filter(o => o.salePrice != null)
    .reduce((s, o) => s + profit(o), 0);

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
        <div className="flex gap-2">
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
                <th className="px-4 py-2 text-left">Date</th>
                <th className="px-4 py-2 text-left">Item</th>
                <th className="px-4 py-2 text-left">Platform</th>
                <th className="px-4 py-2 text-left">Buyer</th>
                <th className="px-4 py-2 text-right">Cost</th>
                <th className="px-4 py-2 text-right">Cashback</th>
                <th className="px-4 py-2 text-right">Sale</th>
                <th className="px-4 py-2 text-right">P&L</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {filtered.map(o => {
                const incomplete = needsInfo(o);
                const p = profit(o);
                return (
                  <tr key={o.id} className={`hover:bg-gray-900/50 ${incomplete ? 'opacity-75' : ''}`}>
                    <td className="px-4 py-3 text-gray-400 whitespace-nowrap">{new Date(o.orderDate).toLocaleDateString()}</td>
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
                    <td className="px-4 py-3 text-right text-gray-400">{fmt(o.cost + o.shippingCost)}</td>
                    <td className="px-4 py-3 text-right text-green-400/70">{o.cashbackAmount > 0 ? fmt(o.cashbackAmount) : '—'}</td>
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
