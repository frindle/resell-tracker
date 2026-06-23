'use client';

import { useEffect, useState } from 'react';

type Reservation = {
  id: number;
  reserveId: string | null;
  bfmrOrderId: string | null;
  trackingNumber: string | null;
  dealTitle: string | null;
  itemName: string | null;
  status: string;
  qty: number;
  retailPrice: number | null;
  totalPayout: number | null;
  datePaid: string | null;
  lastSyncedAt: string;
  orderLinks: Array<{
    id: number;
    orderId: number;
    trackingNumber: string | null;
    quantity: number;
    value: number | null;
    order: { id: number; orderNumber: string | null; platform: string; trackingNumbers: string | null };
  }>;
};

function fmtCurrency(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function fmtDate(s: string | null) {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

const STATUS_STYLES: Record<string, string> = {
  paid: 'bg-green-900/50 text-green-300',
  processed: 'bg-blue-900/50 text-blue-300',
  shipped: 'bg-blue-900/50 text-blue-300',
  pkg_received: 'bg-blue-900/50 text-blue-300',
  purchased: 'bg-yellow-900/50 text-yellow-300',
  reserved: 'bg-yellow-900/50 text-yellow-300',
  return: 'bg-red-900/50 text-red-300',
  returned: 'bg-red-900/50 text-red-300',
  cancelled: 'bg-gray-800 text-gray-500',
  closed: 'bg-gray-800 text-gray-500',
};

type Filter = 'all' | 'linked' | 'unlinked' | 'paid' | 'pending';

export default function ReservationsPage() {
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState('');
  const [syncResult, setSyncResult] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');

  async function load() {
    setLoading(true);
    try {
      const res = await fetch('/api/bfmr/reservations');
      const d = await res.json() as { reservations?: Reservation[]; error?: string };
      if (d.reservations) setReservations(d.reservations);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function sync() {
    setSyncing(true);
    setSyncError('');
    setSyncResult('');
    try {
      const res = await fetch('/api/bfmr/sync-reservations', { method: 'POST' });
      const d = await res.json() as { synced?: number; error?: string };
      if (d.error) setSyncError(d.error);
      else setSyncResult(`Synced ${d.synced ?? 0} reservations`);
      await load();
    } catch (e) {
      setSyncError(String(e));
    } finally {
      setSyncing(false);
    }
  }

  const filtered = reservations.filter(r => {
    if (filter === 'linked' && r.orderLinks.length === 0) return false;
    if (filter === 'unlinked' && r.orderLinks.length > 0) return false;
    if (filter === 'paid' && r.status !== 'paid') return false;
    if (filter === 'pending' && (r.status === 'paid' || r.status === 'cancelled' || r.status === 'closed' || r.status === 'returned')) return false;
    if (search) {
      const q = search.toLowerCase();
      const match =
        (r.bfmrOrderId ?? '').toLowerCase().includes(q) ||
        (r.trackingNumber ?? '').toLowerCase().includes(q) ||
        (r.itemName ?? '').toLowerCase().includes(q) ||
        (r.dealTitle ?? '').toLowerCase().includes(q) ||
        (r.reserveId ?? '').toLowerCase().includes(q) ||
        r.orderLinks.some(l => (l.order.orderNumber ?? '').toLowerCase().includes(q));
      if (!match) return false;
    }
    return true;
  });

  const linkedCount = reservations.filter(r => r.orderLinks.length > 0).length;
  const unlinkedCount = reservations.filter(r => r.orderLinks.length === 0).length;
  const totalPayout = filtered.reduce((s, r) => s + (r.totalPayout ?? 0), 0);
  const linkedPayout = filtered.filter(r => r.orderLinks.length > 0).reduce((s, r) => {
    const linkValue = r.orderLinks.reduce((vs, l) => vs + (l.value ?? 0), 0);
    return s + linkValue;
  }, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">BFMR Reservations</h1>
          <p className="text-sm text-gray-400 mt-1">
            {reservations.length} reservations
            <span className="text-green-400 ml-2">· {linkedCount} linked</span>
            {unlinkedCount > 0 && <span className="text-amber-400 ml-2">· {unlinkedCount} unlinked</span>}
            {totalPayout > 0 && <span className="ml-2">· {fmtCurrency(totalPayout)} total payout</span>}
          </p>
        </div>
        <button
          onClick={sync}
          disabled={syncing}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-4 py-1.5 rounded-md text-sm transition-colors"
        >
          {syncing ? 'Syncing…' : 'Sync from BFMR'}
        </button>
      </div>

      {syncError && <div className="p-3 bg-red-900/30 border border-red-700 rounded-md text-sm text-red-300">{syncError}</div>}
      {syncResult && <div className="p-3 bg-green-900/30 border border-green-700 rounded-md text-sm text-green-300">{syncResult}</div>}

      <div className="flex gap-3 flex-wrap items-center">
        <input
          type="text"
          placeholder="Search order #, tracking, item…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="bg-gray-900 border border-gray-700 rounded-md px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 w-56"
        />
        <select
          className="bg-gray-900 border border-gray-700 rounded-md px-3 py-1.5 text-sm text-white"
          value={filter}
          onChange={e => setFilter(e.target.value as Filter)}
        >
          <option value="all">All</option>
          <option value="linked">Linked</option>
          <option value="unlinked">Unlinked</option>
          <option value="paid">Paid</option>
          <option value="pending">Pending</option>
        </select>
      </div>

      {loading ? (
        <div className="text-gray-500 text-sm">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="text-gray-500 text-sm py-8 text-center">
          No reservations found. Click <strong>Sync from BFMR</strong> to fetch reservation data.
        </div>
      ) : (
        <div className="rounded-lg border border-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-900 text-gray-400 text-xs uppercase">
              <tr>
                <th className="px-4 py-2 text-left">Status</th>
                <th className="px-4 py-2 text-left">Item</th>
                <th className="px-4 py-2 text-left">BFMR Order</th>
                <th className="hidden md:table-cell px-4 py-2 text-left">Tracking</th>
                <th className="px-4 py-2 text-right">Qty</th>
                <th className="px-4 py-2 text-right">Payout</th>
                <th className="hidden sm:table-cell px-4 py-2 text-left">Paid</th>
                <th className="px-4 py-2 text-left">Our Order</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {filtered.map(r => {
                const cls = STATUS_STYLES[r.status] ?? 'bg-gray-800 text-gray-400';
                return (
                  <tr key={r.id} className="hover:bg-gray-900/50">
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
                        {r.status.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-white truncate max-w-[16rem]">{r.itemName || r.dealTitle || '—'}</div>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-300">{r.bfmrOrderId || '—'}</td>
                    <td className="hidden md:table-cell px-4 py-3 font-mono text-xs text-gray-300">{r.trackingNumber || '—'}</td>
                    <td className="px-4 py-3 text-right text-gray-300">{r.qty}</td>
                    <td className="px-4 py-3 text-right">
                      {r.totalPayout != null ? (
                        <span className="text-green-400">{fmtCurrency(r.totalPayout)}</span>
                      ) : '—'}
                    </td>
                    <td className="hidden sm:table-cell px-4 py-3 text-gray-400 text-xs">{fmtDate(r.datePaid)}</td>
                    <td className="px-4 py-3">
                      {r.orderLinks.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {r.orderLinks.map(l => (
                            <a
                              key={l.id}
                              href={`/orders/${l.orderId}`}
                              className="text-xs px-2 py-0.5 bg-gray-800 hover:bg-gray-700 rounded border border-gray-700 text-blue-400"
                            >
                              {l.order.platform} #{l.order.orderNumber ?? l.orderId}
                              {l.trackingNumber && <span className="text-gray-500 ml-1">({l.trackingNumber.slice(-6)})</span>}
                              {l.value != null && <span className="text-green-400 ml-1">{fmtCurrency(l.value)}</span>}
                            </a>
                          ))}
                        </div>
                      ) : (
                        <span className="text-xs text-amber-400">unlinked</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!loading && filtered.length > 0 && linkedPayout > 0 && (
        <div className="text-xs text-gray-500 text-right">
          Linked value: {fmtCurrency(linkedPayout)} of {fmtCurrency(totalPayout)} total payout
        </div>
      )}
    </div>
  );
}
