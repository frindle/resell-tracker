'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

type UnassignedAttachment = { id: number; originalName: string; mimeType: string; createdAt: string };
type OrderOption = {
  id: number;
  platform: string;
  orderNumber: string | null;
  orderDate: string;
  itemDescription: string | null;
  buyer: { name: string } | null;
};

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic'];

export default function SortAssignPage() {
  const [photos, setPhotos] = useState<UnassignedAttachment[]>([]);
  const [orders, setOrders] = useState<OrderOption[]>([]);
  const [active, setActive] = useState<UnassignedAttachment | null>(null);
  const [loading, setLoading] = useState(true);
  const [assigning, setAssigning] = useState(false);
  const [error, setError] = useState('');

  // Picker filters -- group, merchant, date, and free-text all narrow the
  // same order list together (AND, not OR).
  const [group, setGroup] = useState('');
  const [merchant, setMerchant] = useState('');
  const [date, setDate] = useState('');
  const [search, setSearch] = useState('');

  async function load() {
    setLoading(true);
    const [photosRes, ordersRes] = await Promise.all([
      fetch('/api/orders/attachments/unassigned').then(r => r.json()) as Promise<{ attachments: UnassignedAttachment[] }>,
      fetch('/api/orders?all=1').then(r => r.json()) as Promise<OrderOption[]>,
    ]);
    setPhotos(photosRes.attachments ?? []);
    setOrders(Array.isArray(ordersRes) ? ordersRes : []);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  const groups = useMemo(() => Array.from(new Set(orders.map(o => o.buyer?.name).filter((n): n is string => !!n))).sort(), [orders]);
  const merchants = useMemo(() => Array.from(new Set(orders.map(o => o.platform))).sort(), [orders]);

  const filteredOrders = useMemo(() => {
    const q = search.trim().toLowerCase();
    return orders.filter(o => {
      if (group && o.buyer?.name !== group) return false;
      if (merchant && o.platform !== merchant) return false;
      if (date && o.orderDate.slice(0, 10) !== date) return false;
      if (q) {
        const hay = `${o.itemDescription ?? ''} ${o.orderNumber ?? ''} ${o.platform} ${o.buyer?.name ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }).slice(0, 50);
  }, [orders, group, merchant, date, search]);

  async function assign(orderId: number) {
    if (!active) return;
    setAssigning(true);
    setError('');
    try {
      const res = await fetch(`/api/orders/attachments/unassigned/${active.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId }),
      });
      if (res.ok) {
        setPhotos(prev => prev.filter(p => p.id !== active.id));
        setActive(null);
        setGroup(''); setMerchant(''); setDate(''); setSearch('');
      } else {
        setError(await res.text().catch(() => `HTTP ${res.status}`));
      }
    } finally {
      setAssigning(false);
    }
  }

  async function discard(photo: UnassignedAttachment) {
    await fetch(`/api/orders/attachments/unassigned/${photo.id}`, { method: 'DELETE' });
    setPhotos(prev => prev.filter(p => p.id !== photo.id));
    if (active?.id === photo.id) setActive(null);
  }

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-100">Sort &amp; Assign</h1>
        <Link href="/orders" className="text-sm text-gray-400 hover:text-white">← Orders</Link>
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : photos.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-700 py-12 text-center text-gray-500 text-sm">
          Nothing to sort. <Link href="/orders/bulk-upload" className="text-blue-400 hover:underline">Upload some photos →</Link>
        </div>
      ) : (
        <>
          <p className="text-sm text-gray-400">{photos.length} unassigned photo{photos.length === 1 ? '' : 's'}. Click one to attach it to an order.</p>
          <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
            {photos.map(p => {
              const isImage = IMAGE_TYPES.includes(p.mimeType);
              const url = `/api/orders/attachments/unassigned/${p.id}`;
              return (
                <div key={p.id} className="relative group">
                  <button onClick={() => setActive(p)} className="block w-full">
                    {isImage ? (
                      <img src={url} alt={p.originalName} className="aspect-square w-full object-cover rounded border border-gray-700 hover:border-blue-500 transition-colors" />
                    ) : (
                      <div className="aspect-square w-full flex items-center justify-center bg-gray-800 border border-gray-700 rounded text-2xl">📎</div>
                    )}
                  </button>
                  <button
                    onClick={() => discard(p)}
                    title="Discard"
                    className="absolute -top-1.5 -right-1.5 hidden group-hover:flex items-center justify-center w-5 h-5 bg-red-700 hover:bg-red-600 rounded-full text-white text-xs"
                  >×</button>
                </div>
              );
            })}
          </div>
        </>
      )}

      {active && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => setActive(null)}>
          <div className="bg-gray-900 border border-gray-700 rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto p-5 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-start gap-4">
              {IMAGE_TYPES.includes(active.mimeType) ? (
                <img src={`/api/orders/attachments/unassigned/${active.id}`} alt={active.originalName} className="w-40 h-40 object-contain rounded border border-gray-700 bg-black/30" />
              ) : (
                <div className="w-40 h-40 flex items-center justify-center bg-gray-800 border border-gray-700 rounded text-4xl">📎</div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm text-gray-300 truncate">{active.originalName}</p>
                <button onClick={() => setActive(null)} className="text-xs text-gray-500 hover:text-gray-300 mt-1">Close</button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <select value={group} onChange={e => setGroup(e.target.value)} className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-200">
                <option value="">All groups</option>
                {groups.map(g => <option key={g} value={g}>{g}</option>)}
              </select>
              <select value={merchant} onChange={e => setMerchant(e.target.value)} className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-200">
                <option value="">All merchants</option>
                {merchants.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
              <input type="date" value={date} onChange={e => setDate(e.target.value)} className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-200" />
              <input
                type="text"
                placeholder="Search item, order #…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-200"
              />
            </div>

            {error && <p className="text-xs text-red-400">{error}</p>}

            <div className="space-y-1 max-h-72 overflow-y-auto">
              {filteredOrders.length === 0 ? (
                <p className="text-xs text-gray-500 py-4 text-center">No matching orders — narrow down less, or check the filters.</p>
              ) : filteredOrders.map(o => (
                <button
                  key={o.id}
                  disabled={assigning}
                  onClick={() => assign(o.id)}
                  className="w-full text-left px-3 py-2 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-50 border border-gray-700 hover:border-blue-500 transition-colors text-sm"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-gray-200 truncate">{o.itemDescription || '—'}</span>
                    <span className="text-xs text-gray-500 shrink-0">{new Date(o.orderDate).toLocaleDateString()}</span>
                  </div>
                  <div className="text-xs text-gray-500 truncate">{o.platform} {o.buyer?.name ? `· ${o.buyer.name}` : ''} {o.orderNumber ? `· #${o.orderNumber}` : ''}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
