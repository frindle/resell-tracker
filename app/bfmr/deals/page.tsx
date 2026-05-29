'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Deal } from '@/lib/bfmr';

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function profit(deal: Deal) {
  return deal.payout_price - deal.retail_price;
}

export default function DealsPage() {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [inStockOnly, setInStockOnly] = useState(false);
  const [exclusiveOnly, setExclusiveOnly] = useState(false);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page_size: '50' });
      if (inStockOnly) params.set('in_stock', '1');
      if (exclusiveOnly) params.set('exclusive_deals_only', '1');
      const res = await fetch(`/api/bfmr/deals?${params}`);
      if (res.status === 400) { setError('BFMR not configured. Add your API key in Settings.'); return; }
      if (!res.ok) { setError('Failed to load deals.'); return; }
      setDeals(await res.json());
    } catch {
      setError('Network error.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [inStockOnly, exclusiveOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Link href="/bfmr" className="text-gray-500 hover:text-white text-sm transition-colors">← Tracker</Link>
          </div>
          <h1 className="text-2xl font-bold mt-1">Active Deals</h1>
          <p className="text-gray-400 text-sm mt-1">{deals.length} deals available</p>
        </div>
      </div>

      <div className="flex gap-4 items-center">
        <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
          <input type="checkbox" checked={inStockOnly} onChange={e => setInStockOnly(e.target.checked)} className="rounded" />
          In stock only
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
          <input type="checkbox" checked={exclusiveOnly} onChange={e => setExclusiveOnly(e.target.checked)} className="rounded" />
          Exclusive only
        </label>
      </div>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-900/20 px-4 py-3 text-sm text-red-300">
          {error}{' '}
          {error.includes('Settings') && (
            <Link href="/settings" className="underline hover:text-red-200">Go to Settings</Link>
          )}
        </div>
      )}

      {loading ? (
        <div className="text-center text-gray-500 py-12">Loading…</div>
      ) : deals.length === 0 && !error ? (
        <div className="rounded-lg border border-dashed border-gray-700 py-12 text-center text-gray-500">No deals found.</div>
      ) : (
        <div className="rounded-lg border border-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-900 text-gray-400 text-xs uppercase">
              <tr>
                <th className="px-4 py-2 text-left">Deal</th>
                <th className="px-4 py-2 text-left">Retailer</th>
                <th className="px-4 py-2 text-left">Type</th>
                <th className="px-4 py-2 text-right">Retail</th>
                <th className="px-4 py-2 text-right">Payout</th>
                <th className="px-4 py-2 text-right">Spread</th>
                <th className="px-4 py-2 text-left">Closes</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {deals.map(deal => {
                const spread = profit(deal);
                return (
                  <tr key={deal.deal_id} className="hover:bg-gray-900/50">
                    <td className="px-4 py-3 max-w-[240px]">
                      <div className="truncate font-medium">{deal.title}</div>
                      <div className="text-gray-500 text-xs mt-0.5 flex gap-1.5">
                        {deal.deal_code && <span>#{deal.deal_code}</span>}
                        {deal.is_exclusive_deal && <span className="text-purple-400">Exclusive</span>}
                        {deal.is_bundle && <span className="text-blue-400">Bundle</span>}
                        {deal.is_reservation_closed && <span className="text-red-400">Closed</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-400">{deal.retailers}</td>
                    <td className="px-4 py-3 text-gray-400 capitalize">{deal.retail_type}</td>
                    <td className="px-4 py-3 text-right text-gray-400">{fmt(deal.retail_price)}</td>
                    <td className="px-4 py-3 text-right text-gray-300">{fmt(deal.payout_price)}</td>
                    <td className={`px-4 py-3 text-right font-medium ${spread >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {spread >= 0 ? '+' : ''}{fmt(spread)}
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                      {deal.closing_at ? new Date(deal.closing_at).toLocaleDateString() : '—'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <a
                        href={`https://www.buyformeretail.com/deals/${deal.slug}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-500 hover:text-blue-400 text-xs"
                      >
                        View →
                      </a>
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
