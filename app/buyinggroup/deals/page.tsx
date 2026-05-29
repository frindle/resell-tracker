'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

type Deal = {
  id: number;
  title?: string;
  store_name?: string;
  retailer_name?: string;
  type?: string;
  retail_price?: string | number;
  cashback_amount?: string | number;
  payout_amount?: string | number;
  quantity_available?: number;
  expires_at?: string;
  end_date?: string;
  is_exclusive?: boolean;
  is_bundle?: boolean;
  status?: string;
  url?: string;
  [key: string]: unknown;
};

function fmt(v: string | number | undefined) {
  const n = parseFloat(String(v ?? 0));
  if (isNaN(n) || n === 0) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function spread(deal: Deal): number {
  const payout = parseFloat(String(deal.cashback_amount ?? deal.payout_amount ?? 0));
  const retail = parseFloat(String(deal.retail_price ?? 0));
  if (!payout || !retail) return 0;
  return payout - retail;
}

type DataType = 'on_sale_now' | 'below_cost' | 'all';

export default function BuyingGroupDealsPage() {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [dataType, setDataType] = useState<DataType>('on_sale_now');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');

  useEffect(() => {
    setLoading(true);
    const qs = new URLSearchParams({ data_type: dataType, title: search, page_size: '60' });
    fetch(`/api/buyinggroup/deals?${qs}`)
      .then(r => {
        if (r.status === 400) throw new Error('not_configured');
        if (!r.ok) throw new Error(`API error ${r.status}`);
        return r.json();
      })
      .then(data => {
        const items: Deal[] = Array.isArray(data) ? data : (data.results ?? data.data ?? []);
        setDeals(items);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [dataType, search]);

  const DATA_TYPES: { key: DataType; label: string }[] = [
    { key: 'on_sale_now', label: 'On Sale Now' },
    { key: 'below_cost',  label: 'Below Cost' },
    { key: 'all',         label: 'All Deals' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">BuyingGroup Deals</h1>
          <Link href="/buyinggroup" className="text-gray-500 text-sm hover:text-white transition-colors">
            ← My Receipts
          </Link>
        </div>
      </div>

      {error === 'not_configured' ? (
        <div className="rounded-lg border border-yellow-800 bg-yellow-900/20 px-4 py-3 text-sm text-yellow-300">
          BuyingGroup not configured.{' '}
          <Link href="/settings" className="underline hover:text-yellow-200">Add credentials in Settings</Link>
        </div>
      ) : error ? (
        <div className="rounded-lg border border-red-800 bg-red-900/20 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-2">
          {DATA_TYPES.map(dt => (
            <button key={dt.key} onClick={() => setDataType(dt.key)}
              className={`text-sm px-3 py-1.5 rounded-md transition-colors ${
                dataType === dt.key
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700'
              }`}>
              {dt.label}
            </button>
          ))}
        </div>
        <form onSubmit={e => { e.preventDefault(); setSearch(searchInput); }}
          className="flex gap-2 ml-auto">
          <input
            type="text"
            placeholder="Search deals…"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            className="input text-sm py-1.5 w-48"
          />
          <button type="submit"
            className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-sm px-3 py-1.5 rounded-md transition-colors">
            Search
          </button>
        </form>
      </div>

      {loading ? (
        <div className="text-gray-500 text-sm py-8 text-center">Loading deals…</div>
      ) : (
        <div className="rounded-lg border border-gray-800 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-900 text-gray-400 text-xs uppercase">
              <tr>
                <th className="px-4 py-2 text-left">Deal</th>
                <th className="px-4 py-2 text-left">Store</th>
                <th className="px-4 py-2 text-left">Type</th>
                <th className="px-4 py-2 text-right">Retail</th>
                <th className="px-4 py-2 text-right">Cashback</th>
                <th className="px-4 py-2 text-right">Spread</th>
                <th className="px-4 py-2 text-left">Qty</th>
                <th className="px-4 py-2 text-left">Expires</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {deals.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-gray-500">No deals found.</td>
                </tr>
              )}
              {deals.map(d => {
                const s = spread(d);
                return (
                  <tr key={d.id} className="hover:bg-gray-900/40">
                    <td className="px-4 py-2 max-w-[280px]">
                      <div className="flex flex-wrap gap-1 items-start">
                        <span className="text-gray-200 text-xs">{String(d.title ?? '—')}</span>
                        {d.is_exclusive && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-purple-900/50 text-purple-300">Exclusive</span>
                        )}
                        {d.is_bundle && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-indigo-900/50 text-indigo-300">Bundle</span>
                        )}
                        {String(d.status ?? '').toLowerCase().includes('close') && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-gray-800 text-gray-500">Closing</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2 text-gray-400 text-xs">{String(d.store_name ?? d.retailer_name ?? '—')}</td>
                    <td className="px-4 py-2 text-gray-400 text-xs">{String(d.type ?? '—')}</td>
                    <td className="px-4 py-2 text-right text-gray-300">{fmt(d.retail_price)}</td>
                    <td className="px-4 py-2 text-right text-green-400">{fmt(d.cashback_amount ?? d.payout_amount)}</td>
                    <td className={`px-4 py-2 text-right font-medium ${s > 0 ? 'text-green-400' : s < 0 ? 'text-red-400' : 'text-gray-500'}`}>
                      {s !== 0 ? fmt(s) : '—'}
                    </td>
                    <td className="px-4 py-2 text-gray-400 text-xs">
                      {d.quantity_available != null ? String(d.quantity_available) : '—'}
                    </td>
                    <td className="px-4 py-2 text-gray-400 text-xs whitespace-nowrap">
                      {d.expires_at ?? d.end_date
                        ? new Date(String(d.expires_at ?? d.end_date)).toLocaleDateString()
                        : '—'}
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
