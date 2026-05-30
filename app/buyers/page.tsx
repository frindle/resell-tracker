'use client';

import { useEffect, useState } from 'react';

type Buyer = {
  id: number;
  name: string;
  createdAt: string;
  orderCount: number;
  totalPaid: number;
  lastOrderDate: string | null;
};

type OrderRow = {
  id: number;
  orderDate: string;
  platform: string;
  orderNumber: string | null;
  itemDescription: string | null;
  cost: number;
  salePrice: number | null;
};

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function PayoutHistory({ buyerId }: { buyerId: number }) {
  const [orders, setOrders] = useState<OrderRow[] | null>(null);

  useEffect(() => {
    fetch(`/api/buyers/${buyerId}/orders`)
      .then(r => r.json())
      .then(setOrders)
      .catch(() => setOrders([]));
  }, [buyerId]);

  if (orders === null) {
    return <div className="px-4 py-3 text-xs text-gray-600">Loading…</div>;
  }
  if (orders.length === 0) {
    return <div className="px-4 py-3 text-xs text-gray-600">No paid orders recorded for this group yet.</div>;
  }

  return (
    <div className="divide-y divide-gray-800">
      {orders.map(o => (
        <div key={o.id} className="px-4 py-2 flex items-center gap-4 text-xs">
          <span className="text-gray-500 w-20 shrink-0">
            {new Date(o.orderDate).toLocaleDateString()}
          </span>
          <span className="text-gray-500 w-16 shrink-0">{o.platform}</span>
          <span className="text-gray-400 flex-1 truncate" title={o.itemDescription ?? ''}>
            {o.itemDescription || o.orderNumber || '—'}
          </span>
          <span className="text-gray-500 w-20 text-right shrink-0">cost {fmt(o.cost)}</span>
          <span className="text-green-400 w-20 text-right font-medium shrink-0">
            {fmt(o.salePrice ?? 0)}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function BuyersPage() {
  const [buyers, setBuyers] = useState<Buyer[]>([]);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [openHistory, setOpenHistory] = useState<number | null>(null);

  function load() {
    fetch('/api/buyers').then(r => r.json()).then(setBuyers);
  }

  useEffect(() => { load(); }, []);

  async function add() {
    if (!name.trim()) return;
    setSaving(true);
    await fetch('/api/buyers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() }),
    });
    setName('');
    setSaving(false);
    load();
  }

  async function remove(id: number) {
    if (!confirm('Delete this group? Orders assigned to them will become unassigned.')) return;
    await fetch(`/api/buyers/${id}`, { method: 'DELETE' });
    load();
  }

  const totalAcrossAll = buyers.reduce((sum, b) => sum + b.totalPaid, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Buying Groups</h1>
        <p className="text-gray-400 text-sm mt-1">Track payouts per group over time</p>
      </div>

      <div className="flex gap-2 max-w-sm">
        <input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && add()}
          className="input flex-1"
          placeholder="Group name"
        />
        <button onClick={add} disabled={saving || !name.trim()} className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-4 py-2 rounded-md text-sm transition-colors">
          Add
        </button>
      </div>

      {buyers.length > 0 && totalAcrossAll > 0 && (
        <p className="text-sm text-gray-500">
          Total received across all groups:{' '}
          <span className="text-white font-medium">{fmt(totalAcrossAll)}</span>
        </p>
      )}

      <div className="space-y-3">
        {buyers.length === 0 && (
          <p className="text-gray-500 text-sm">No groups yet.</p>
        )}
        {buyers.map(b => {
          const histOpen = openHistory === b.id;
          return (
            <div key={b.id} className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
              <div className="flex items-center gap-4 px-4 py-3">
                <span className="font-medium flex-1">{b.name}</span>

                <div className="flex items-center gap-6 text-sm">
                  <div className="text-right">
                    <div className="text-gray-500 text-xs">Orders</div>
                    <div className="text-gray-300">{b.orderCount}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-gray-500 text-xs">Total paid</div>
                    <div className={b.totalPaid > 0 ? 'text-green-400 font-medium' : 'text-gray-600'}>
                      {b.totalPaid > 0 ? fmt(b.totalPaid) : '—'}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-gray-500 text-xs">Last order</div>
                    <div className="text-gray-400 text-xs">
                      {b.lastOrderDate ? new Date(b.lastOrderDate).toLocaleDateString() : '—'}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-3 ml-2">
                  {b.orderCount > 0 && (
                    <button
                      onClick={() => setOpenHistory(histOpen ? null : b.id)}
                      className={`text-xs px-2 py-1 rounded transition-colors ${
                        histOpen
                          ? 'bg-blue-900/50 text-blue-300'
                          : 'text-gray-500 hover:text-gray-300'
                      }`}
                    >
                      History
                    </button>
                  )}
                  <button onClick={() => remove(b.id)} className="text-gray-600 hover:text-red-400 text-xs transition-colors">
                    Remove
                  </button>
                </div>
              </div>

              {histOpen && (
                <div className="border-t border-gray-800 bg-gray-950">
                  <div className="px-4 py-2 flex items-center gap-4 text-xs text-gray-600 font-medium uppercase tracking-wide border-b border-gray-800">
                    <span className="w-20">Date</span>
                    <span className="w-16">Platform</span>
                    <span className="flex-1">Item</span>
                    <span className="w-20 text-right">Cost</span>
                    <span className="w-20 text-right">Paid</span>
                  </div>
                  <PayoutHistory buyerId={b.id} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
