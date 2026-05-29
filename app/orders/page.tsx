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
  salePrice: number;
  buyer: { name: string } | null;
  notes: string | null;
};

function profit(o: Order) {
  return o.salePrice - (o.cost + o.shippingCost - o.cashbackAmount);
}

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

const PLATFORMS = ['All', 'Amazon', 'Walmart', 'Other'];

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [platform, setPlatform] = useState('All');
  const [search, setSearch] = useState('');

  useEffect(() => {
    fetch('/api/orders').then(r => r.json()).then(setOrders);
  }, []);

  const filtered = orders.filter(o => {
    if (platform !== 'All' && o.platform !== platform) return false;
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

  const totalProfit = filtered.reduce((s, o) => s + profit(o), 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Orders</h1>
          <p className="text-gray-400 text-sm mt-1">{filtered.length} orders · P&L: <span className={totalProfit >= 0 ? 'text-green-400' : 'text-red-400'}>{fmt(totalProfit)}</span></p>
        </div>
        <div className="flex gap-2">
          <Link href="/import" className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-sm px-3 py-1.5 rounded-md transition-colors">
            Import CSV
          </Link>
          <Link href="/orders/new" className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-3 py-1.5 rounded-md transition-colors">
            + New Order
          </Link>
        </div>
      </div>

      <div className="flex gap-3 flex-wrap">
        <input
          type="text"
          placeholder="Search item, buyer, order #…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="bg-gray-900 border border-gray-700 rounded-md px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 w-64"
        />
        <div className="flex gap-1">
          {PLATFORMS.map(p => (
            <button
              key={p}
              onClick={() => setPlatform(p)}
              className={`px-3 py-1.5 rounded-md text-sm transition-colors ${platform === p ? 'bg-blue-600 text-white' : 'bg-gray-900 border border-gray-700 text-gray-400 hover:text-white'}`}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-700 py-12 text-center text-gray-500">
          No orders found.
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
                const p = profit(o);
                return (
                  <tr key={o.id} className="hover:bg-gray-900/50">
                    <td className="px-4 py-3 text-gray-400 whitespace-nowrap">{new Date(o.orderDate).toLocaleDateString()}</td>
                    <td className="px-4 py-3 max-w-[200px] truncate">
                      <Link href={`/orders/${o.id}`} className="hover:text-blue-400 transition-colors">
                        {o.itemDescription || '—'}
                      </Link>
                      {o.orderNumber && <span className="text-gray-500 text-xs ml-2">#{o.orderNumber}</span>}
                    </td>
                    <td className="px-4 py-3 text-gray-400">{o.platform}</td>
                    <td className="px-4 py-3 text-gray-400">{o.buyer?.name || '—'}</td>
                    <td className="px-4 py-3 text-right text-gray-400">{fmt(o.cost + o.shippingCost)}</td>
                    <td className="px-4 py-3 text-right text-green-400/70">{o.cashbackAmount > 0 ? fmt(o.cashbackAmount) : '—'}</td>
                    <td className="px-4 py-3 text-right">{fmt(o.salePrice)}</td>
                    <td className={`px-4 py-3 text-right font-medium ${p >= 0 ? 'text-green-400' : 'text-red-400'}`}>{fmt(p)}</td>
                    <td className="px-4 py-3 text-right">
                      <Link href={`/orders/${o.id}`} className="text-gray-500 hover:text-white text-xs transition-colors">Edit</Link>
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
