'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

type BlockedOrder = {
  id: number;
  platform: string;
  orderNumber: string | null;
  orderDate: string;
  itemDescription: string | null;
  cost: number;
  shippingAddress: string | null;
  blockedAddressPattern: string | null;
  buyer: { name: string } | null;
  createdAt: string;
};

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function fmtDate(s: string) {
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleDateString();
}

export default function BlockedOrdersPage() {
  const [orders, setOrders] = useState<BlockedOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [working, setWorking] = useState(false);
  const [msg, setMsg] = useState('');

  function load() {
    setLoading(true);
    fetch('/api/orders/blocked')
      .then(r => r.json())
      .then(d => setOrders(Array.isArray(d) ? d : []))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  function toggle(id: number) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(prev => prev.size === orders.length ? new Set() : new Set(orders.map(o => o.id)));
  }

  async function act(action: 'allow' | 'delete') {
    if (selected.size === 0) return;
    if (action === 'delete' && !confirm(`Delete ${selected.size} blocked order(s)?`)) return;
    setWorking(true);
    setMsg('');
    try {
      const res = await fetch('/api/orders/blocked', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...selected], action }),
      });
      const d = await res.json();
      if (d.error) setMsg(d.error);
      else setMsg(action === 'allow' ? `Allowed ${d.allowed}` : `Deleted ${d.deleted}`);
      setSelected(new Set());
      load();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold">Blocked imports</h1>
          <p className="text-sm text-gray-400 mt-1">
            Orders that matched a blocked-address pattern at import time. Approve to join the main orders list, or delete.{' '}
            <Link href="/buyers" className="text-blue-400 hover:underline">Manage patterns →</Link>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {msg && <span className="text-xs text-gray-400">{msg}</span>}
          <button
            onClick={() => act('allow')}
            disabled={selected.size === 0 || working}
            className="bg-emerald-700 hover:bg-emerald-600 disabled:opacity-30 text-white text-sm px-3 py-1.5 rounded-md transition-colors"
          >
            Allow {selected.size > 0 && `(${selected.size})`}
          </button>
          <button
            onClick={() => act('delete')}
            disabled={selected.size === 0 || working}
            className="bg-red-800 hover:bg-red-700 disabled:opacity-30 text-white text-sm px-3 py-1.5 rounded-md transition-colors"
          >
            Delete {selected.size > 0 && `(${selected.size})`}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-gray-500 text-sm py-8 text-center">Loading…</div>
      ) : orders.length === 0 ? (
        <div className="text-gray-500 text-sm py-8 text-center">No blocked orders.</div>
      ) : (
        <div className="rounded-lg border border-gray-800 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-900 text-gray-400 text-xs uppercase">
              <tr>
                <th className="px-3 py-2 w-8">
                  <input
                    type="checkbox"
                    checked={selected.size === orders.length}
                    onChange={toggleAll}
                  />
                </th>
                <th className="px-3 py-2 text-left">Platform</th>
                <th className="px-3 py-2 text-left">Order #</th>
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-left">Item</th>
                <th className="px-3 py-2 text-right">Cost</th>
                <th className="px-3 py-2 text-left">Address</th>
                <th className="px-3 py-2 text-left">Matched pattern</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {orders.map(o => (
                <tr key={o.id} className="hover:bg-gray-900/40">
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={selected.has(o.id)}
                      onChange={() => toggle(o.id)}
                    />
                  </td>
                  <td className="px-3 py-2 text-gray-300">{o.platform}</td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-300">{o.orderNumber ?? `#${o.id}`}</td>
                  <td className="px-3 py-2 text-gray-400 text-xs whitespace-nowrap">{fmtDate(o.orderDate)}</td>
                  <td className="px-3 py-2 text-gray-300 max-w-xs truncate" title={o.itemDescription ?? ''}>{o.itemDescription ?? '—'}</td>
                  <td className="px-3 py-2 text-right text-gray-300">{fmt(o.cost)}</td>
                  <td className="px-3 py-2 text-gray-400 text-xs max-w-xs truncate" title={o.shippingAddress ?? ''}>{o.shippingAddress ?? '—'}</td>
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-yellow-900/50 text-yellow-300 font-mono">
                      {o.blockedAddressPattern}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
