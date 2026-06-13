'use client';

import { useEffect, useState, useMemo } from 'react';

type Rate = {
  id: number;
  value: number;
  rate: number;
  paymentTerms: number;
  maximumPaymentTerms: number;
  flexType: string;
  availableCap: number;
  unfulfilledPerSellerCap: number;
};

type Brand = {
  name: string;
  rates: Rate[];
};

type OpenReservation = {
  id: number;
  brandName: string;
  value: number;
  quantity: number;
  submissionDeadline: string;
};

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function fmtDate(s: string) {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function ReserveForm({ rateId, onReserved, onCancel }: {
  rateId: number;
  onReserved: (r: { reservationId: number; submissionId: string; submissionDeadline: string }) => void;
  onCancel: () => void;
}) {
  const [quantity, setQuantity] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function reserve() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/cardcenter/reserve-only', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ buyOrderId: rateId, quantity }),
      });
      const d = await res.json() as { reservationId?: number; submissionId?: string; submissionDeadline?: string; error?: string };
      if (!res.ok || d.error) { setError(d.error ?? 'Failed'); return; }
      onReserved({ reservationId: d.reservationId!, submissionId: d.submissionId!, submissionDeadline: d.submissionDeadline! });
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <label className="text-xs text-gray-400">Qty</label>
      <input
        type="number" min={1} value={quantity}
        onChange={e => setQuantity(Math.max(1, parseInt(e.target.value) || 1))}
        className="w-16 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
      />
      <button onClick={reserve} disabled={loading}
        className="text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-3 py-1 rounded transition-colors">
        {loading ? 'Reserving…' : 'Confirm'}
      </button>
      <button onClick={onCancel} className="text-xs text-gray-500 hover:text-gray-300 transition-colors">Cancel</button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}

function BrandRow({ brand, openReservations, onReserved, onCancelled }: {
  brand: Brand;
  openReservations: OpenReservation[];
  onReserved: (res: OpenReservation) => void;
  onCancelled: (id: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [reservingRateId, setReservingRateId] = useState<number | null>(null);
  const [cancellingId, setCancellingId] = useState<number | null>(null);
  const [cancelError, setCancelError] = useState('');

  async function cancelReservation(reservationId: number) {
    setCancellingId(reservationId);
    setCancelError('');
    try {
      const res = await fetch(`/api/cardcenter/reservations/${reservationId}`, { method: 'DELETE' });
      const d = await res.json() as { error?: string };
      if (!res.ok || d.error) { setCancelError(d.error ?? 'Cancel failed'); return; }
      onCancelled(reservationId);
    } catch (e) {
      setCancelError(String(e));
    } finally {
      setCancellingId(null);
    }
  }

  const brandReservations = openReservations.filter(r => r.brandName === brand.name);
  const bestRate = brand.rates.reduce((best, r) => r.rate > best ? r.rate : best, 0);
  const values = [...new Set(brand.rates.map(r => r.value))].sort((a, b) => a - b);

  return (
    <div className="border border-gray-800 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-900/60 transition-colors text-left"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="font-medium text-sm text-white truncate">{brand.name}</span>
          {brandReservations.length > 0 && (
            <span className="shrink-0 text-xs bg-green-900/60 text-green-400 px-1.5 py-0.5 rounded">
              {brandReservations.length} open
            </span>
          )}
        </div>
        <div className="flex items-center gap-4 shrink-0 ml-2">
          <span className="hidden sm:block text-xs text-gray-500">
            {values.map(v => fmt(v)).join(' · ')}
          </span>
          <span className="text-xs text-gray-400">up to {(bestRate * 100).toFixed(1)}%</span>
          <span className="text-gray-600 text-xs">{expanded ? '▲' : '▼'}</span>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-gray-800">
          {brandReservations.length > 0 && (
            <div className="px-4 py-2 bg-green-950/30 border-b border-gray-800 space-y-1.5">
              <p className="text-xs text-gray-500 uppercase tracking-wide">Open reservations</p>
              {brandReservations.map(r => (
                <div key={r.id} className="flex items-center justify-between gap-2">
                  <span className="text-xs text-green-400">
                    #{r.id} · {fmt(r.value)} · {r.quantity} cards · Due {fmtDate(r.submissionDeadline)}
                  </span>
                  <button
                    onClick={() => cancelReservation(r.id)}
                    disabled={cancellingId === r.id}
                    className="text-xs text-red-500 hover:text-red-400 disabled:opacity-50 transition-colors shrink-0"
                  >
                    {cancellingId === r.id ? 'Cancelling…' : 'Cancel'}
                  </button>
                </div>
              ))}
              {cancelError && <p className="text-xs text-red-400">{cancelError}</p>}
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-900 text-gray-500 uppercase">
                <tr>
                  <th className="px-4 py-2 text-left">Value</th>
                  <th className="px-4 py-2 text-right">Rate</th>
                  <th className="px-4 py-2 text-right">Terms</th>
                  <th className="hidden sm:table-cell px-4 py-2 text-right">Available cap</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {brand.rates.map(r => (
                  <tr key={r.id} className="hover:bg-gray-900/40">
                    <td className="px-4 py-2.5 text-green-400 font-medium">{fmt(r.value)}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-white">{(r.rate * 100).toFixed(2)}%</td>
                    <td className="px-4 py-2.5 text-right text-gray-300">
                      {r.paymentTerms}d
                      {r.flexType !== 'None' && (
                        <span className="text-gray-500"> – {r.maximumPaymentTerms}d</span>
                      )}
                    </td>
                    <td className="hidden sm:table-cell px-4 py-2.5 text-right text-gray-400">
                      {fmt(r.availableCap)}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {reservingRateId === r.id ? (
                        <ReserveForm
                          rateId={r.id}
                          onReserved={result => {
                            onReserved({ id: result.reservationId, brandName: brand.name, value: r.value, quantity: 0, submissionDeadline: result.submissionDeadline });
                            setReservingRateId(null);
                          }}
                          onCancel={() => setReservingRateId(null)}
                        />
                      ) : (
                        <button
                          onClick={() => setReservingRateId(r.id)}
                          className="text-xs bg-gray-800 hover:bg-blue-700 border border-gray-700 hover:border-blue-600 text-gray-300 hover:text-white px-3 py-1 rounded transition-colors"
                        >
                          Reserve
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export default function RatesPage() {
  const [brands, setBrands] = useState<Brand[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [openReservations, setOpenReservations] = useState<OpenReservation[]>([]);

  useEffect(() => {
    Promise.all([
      fetch('/api/cardcenter/buy-orders').then(r => r.json()),
      fetch('/api/cardcenter/reservations').then(r => r.json()),
    ])
      .then(([buyOrders, reservations]: [{ brands?: Brand[]; error?: string }, { reservations?: OpenReservation[]; error?: string }]) => {
        if (buyOrders.error) { setError(buyOrders.error); return; }
        setBrands(buyOrders.brands ?? []);
        setOpenReservations(reservations.reservations ?? []);
      })
      .catch(() => setError('Failed to load buy orders'))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    if (!search.trim()) return brands;
    const q = search.toLowerCase();
    return brands.filter(b => b.name.toLowerCase().includes(q));
  }, [brands, search]);

  function onReserved(r: OpenReservation) {
    setOpenReservations(prev => [...prev, r]);
  }

  function onCancelled(id: number) {
    setOpenReservations(prev => prev.filter(r => r.id !== id));
  }

  const totalOpen = openReservations.length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Rates</h1>
        <p className="text-gray-400 text-sm mt-1">
          {brands.length} brands
          {totalOpen > 0 && (
            <> · <span className="text-green-400">{totalOpen} open reservation{totalOpen !== 1 ? 's' : ''}</span></>
          )}
        </p>
      </div>

      <input
        type="text"
        placeholder="Search brands…"
        value={search}
        onChange={e => setSearch(e.target.value)}
        className="w-full max-w-sm bg-gray-900 border border-gray-700 rounded-md px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
      />

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-900/20 px-4 py-3 text-sm text-red-300">{error}</div>
      )}

      {loading ? (
        <div className="text-center text-gray-500 py-12">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-700 py-12 text-center text-gray-500">
          {search ? `No brands matching "${search}"` : 'No buy orders available.'}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(brand => (
            <BrandRow
              key={brand.name}
              brand={brand}
              openReservations={openReservations}
              onReserved={onReserved}
              onCancelled={onCancelled}
            />
          ))}
        </div>
      )}
    </div>
  );
}
