'use client';

import { useEffect, useState, useMemo, useRef } from 'react';

type BGDeal = {
  id: number;
  key: string;
  deal_id?: string;
  title: string;
  store_name: string;
  retail_price: string;
  cashback_amount: string;
  quantity_available: number;
  expires_at?: string;
  is_exclusive: boolean;
  is_bundle: boolean;
  status: string;
  url?: string;
  [key: string]: unknown;
};

type CommitmentItem = {
  key: string;
  item_title: string;
  item_model: string;
  item_image_new?: string;
  in_stock: boolean;
  commission: string;
  current_cost: string;
  limit_user: number | null;
  limit_total: number | null;
  enabled: boolean;
  commitment_count: number | null;
};

type Commitment = {
  key: string;
  commitment_id: string;
  deal: { key: string; title: string; deal_id: string };
  item: { key: string; item_id: string };
};

function fmt(v: string | number | null | undefined) {
  const n = parseFloat(String(v ?? 0));
  if (isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function fmtDate(s: string | null | undefined): string | null {
  if (!s) return null;
  try {
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch { return null; }
}

export default function BgDealsPage() {
  const [deals, setDeals] = useState<BGDeal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [dataType, setDataType] = useState<'on_sale_now' | 'below_cost' | 'all'>('on_sale_now');
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [dealItems, setDealItems] = useState<Record<string, CommitmentItem[]>>({});
  const [dealItemsLoading, setDealItemsLoading] = useState<Record<string, boolean>>({});
  const [dealItemsError, setDealItemsError] = useState<Record<string, string>>({});
  const [commitments, setCommitments] = useState<Commitment[]>([]);
  const [committing, setCommitting] = useState<string | null>(null); // itemKey
  const [cancelling, setCancelling] = useState<string | null>(null); // deal key
  const [actionMsg, setActionMsg] = useState<Record<string, string>>({});
  const prefetchStarted = useRef(false);

  function loadDeals() {
    setLoading(true);
    setError('');
    prefetchStarted.current = false;
    const qs = new URLSearchParams({ data_type: dataType, page_size: '60' });
    fetch(`/api/buyinggroup/deals?${qs}`)
      .then(async r => {
        if (!r.ok) throw new Error(await r.text());
        return r.json() as Promise<{ results: BGDeal[]; count: number }>;
      })
      .then(d => setDeals(d.results ?? []))
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }

  function loadCommitments() {
    fetch('/api/buyinggroup/commitment/list')
      .then(r => r.ok ? r.json() : { commitments: [] })
      .then((d: { commitments: Commitment[] }) => setCommitments(d.commitments ?? []))
      .catch(() => {});
  }

  useEffect(() => {
    loadDeals();
    loadCommitments();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataType]);

  // Pre-fetch items for active deals in background batches of 5
  useEffect(() => {
    if (!deals.length || prefetchStarted.current) return;
    prefetchStarted.current = true;
    const active = deals.filter(d => d.status === 'active' || d.quantity_available > 0);
    async function prefetch() {
      for (let i = 0; i < active.length; i += 5) {
        const batch = active.slice(i, i + 5);
        await Promise.all(batch.map(async deal => {
          if (!deal.key || dealItems[deal.key]) return;
          setDealItemsLoading(prev => ({ ...prev, [deal.key]: true }));
          try {
            const r = await fetch(`/api/buyinggroup/commitment/items?dealKey=${encodeURIComponent(deal.key)}`);
            if (!r.ok) throw new Error(await r.text());
            const items = await r.json() as CommitmentItem[];
            setDealItems(prev => ({ ...prev, [deal.key]: items }));
          } catch (e) {
            setDealItemsError(prev => ({ ...prev, [deal.key]: String(e) }));
          } finally {
            setDealItemsLoading(prev => ({ ...prev, [deal.key]: false }));
          }
        }));
      }
    }
    prefetch().catch(() => {});
  }, [deals]);

  const committedDealKeys = useMemo(() => new Set(commitments.map(c => c.deal.key)), [commitments]);
  const committedItemKeys = useMemo(() => new Set(commitments.map(c => c.item.key)), [commitments]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const result = deals.filter(d => !q || d.title.toLowerCase().includes(q) || d.store_name.toLowerCase().includes(q));
    return result.sort((a, b) => {
      // In-stock deals first
      const aStock = (dealItems[a.key] ?? []).some(i => i.in_stock);
      const bStock = (dealItems[b.key] ?? []).some(i => i.in_stock);
      if (bStock !== aStock) return (bStock ? 1 : 0) - (aStock ? 1 : 0);
      // Then by cashback spread (retail - cashback, ascending = better deal for buyer)
      const aSpread = parseFloat(a.retail_price) - parseFloat(a.cashback_amount);
      const bSpread = parseFloat(b.retail_price) - parseFloat(b.cashback_amount);
      return aSpread - bSpread;
    });
  }, [deals, search, dealItems]);

  async function loadItems(dealKey: string) {
    if (dealItems[dealKey]) return;
    setDealItemsLoading(prev => ({ ...prev, [dealKey]: true }));
    try {
      const r = await fetch(`/api/buyinggroup/commitment/items?dealKey=${encodeURIComponent(dealKey)}`);
      if (!r.ok) throw new Error(await r.text());
      const items = await r.json() as CommitmentItem[];
      setDealItems(prev => ({ ...prev, [dealKey]: items }));
    } catch (e) {
      setDealItemsError(prev => ({ ...prev, [dealKey]: String(e) }));
    } finally {
      setDealItemsLoading(prev => ({ ...prev, [dealKey]: false }));
    }
  }

  async function commit(dealKey: string, itemKey: string) {
    setCommitting(itemKey);
    setActionMsg(prev => ({ ...prev, [itemKey]: '' }));
    try {
      const r = await fetch('/api/buyinggroup/commitment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dealKey, itemKey }),
      });
      if (!r.ok) throw new Error(await r.text());
      setActionMsg(prev => ({ ...prev, [itemKey]: 'Committed!' }));
      loadCommitments();
    } catch (e) {
      setActionMsg(prev => ({ ...prev, [itemKey]: String(e) }));
    } finally {
      setCommitting(null);
    }
  }

  async function cancelCommitment(dealKey: string, itemKey: string) {
    setCancelling(dealKey);
    try {
      const r = await fetch('/api/buyinggroup/commitment', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dealKey, itemKey }),
      });
      if (!r.ok) throw new Error(await r.text());
      loadCommitments();
    } catch (e) {
      setActionMsg(prev => ({ ...prev, [dealKey]: String(e) }));
    } finally {
      setCancelling(null);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">Deals</h1>
          <p className="text-gray-400 text-sm mt-1">{filtered.length} of {deals.length} deals</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <input
          type="text"
          placeholder="Search deals…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="bg-gray-900 border border-gray-700 rounded-md px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 w-48"
        />
        <select
          value={dataType}
          onChange={e => setDataType(e.target.value as typeof dataType)}
          className="bg-gray-900 border border-gray-700 rounded-md px-2 py-1.5 text-sm text-gray-300 focus:outline-none focus:border-blue-500"
        >
          <option value="on_sale_now">On Sale Now</option>
          <option value="below_cost">Below Cost</option>
          <option value="all">All Deals</option>
        </select>
        <button onClick={loadDeals} className="text-xs text-gray-500 hover:text-blue-400 transition-colors ml-auto">
          ↺ Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-900/20 px-4 py-3 text-sm text-red-300">{error}</div>
      )}

      {loading ? (
        <div className="text-center text-gray-500 py-12">Loading deals…</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-700 py-12 text-center text-gray-500">
          No deals match your filters.
        </div>
      ) : (
        <div className="rounded-lg border border-gray-800 overflow-visible">
          <table className="w-full text-sm">
            <thead className="bg-gray-900 text-gray-500 text-xs uppercase">
              <tr>
                <th className="px-4 py-2 text-left rounded-tl-lg">Deal</th>
                <th className="hidden sm:table-cell px-4 py-2 text-left">Store</th>
                <th className="hidden md:table-cell px-4 py-2 text-right">Retail</th>
                <th className="px-4 py-2 text-right">Payout</th>
                <th className="hidden md:table-cell px-4 py-2 text-right">Your Cost</th>
                <th className="hidden sm:table-cell px-4 py-2 text-center">Qty</th>
                <th className="px-4 py-2 text-center">Status</th>
                <th className="px-4 py-2 rounded-tr-lg"></th>
              </tr>
            </thead>
            {filtered.map(deal => {
              const isExpanded = expandedKey === deal.key;
              const items = dealItems[deal.key] ?? null;
              const loadingItems = dealItemsLoading[deal.key] ?? false;
              const itemsErr = dealItemsError[deal.key] ?? '';
              const isCommitted = committedDealKeys.has(deal.key);
              const myCommitment = commitments.find(c => c.deal.key === deal.key);
              const hasStock = (items ?? []).some(i => i.in_stock);
              const expires = fmtDate(deal.expires_at);
              const retail = parseFloat(deal.retail_price);
              const payout = parseFloat(deal.cashback_amount);
              const yourCost = isNaN(retail) || isNaN(payout) ? null : retail - payout;

              return (
                <tbody key={deal.key} className="border-t border-gray-800">
                  <tr
                    className={`hover:bg-gray-900/40 cursor-pointer ${isExpanded ? 'bg-gray-900/60' : ''}`}
                    onClick={() => {
                      const next = isExpanded ? null : deal.key;
                      setExpandedKey(next);
                      if (next) loadItems(next);
                    }}
                  >
                    <td className="px-4 py-2.5 text-gray-200 font-medium max-w-xs">
                      <div className="flex items-center gap-2">
                        <span className="truncate block">{deal.title}</span>
                        {hasStock && <span className="shrink-0 text-xs text-green-400">●</span>}
                        {deal.is_exclusive && <span className="shrink-0 text-xs bg-purple-900/50 text-purple-300 px-1 rounded">excl</span>}
                      </div>
                    </td>
                    <td className="hidden sm:table-cell px-4 py-2.5 text-gray-400 text-xs">{deal.store_name}</td>
                    <td className="hidden md:table-cell px-4 py-2.5 text-right text-gray-400 font-mono text-xs">{fmt(deal.retail_price)}</td>
                    <td className="px-4 py-2.5 text-right text-green-400 font-mono text-xs">{fmt(deal.cashback_amount)}</td>
                    <td className="hidden md:table-cell px-4 py-2.5 text-right font-mono text-xs">
                      {yourCost !== null ? (
                        <span className={yourCost <= 0 ? 'text-green-400' : 'text-gray-300'}>{fmt(yourCost)}</span>
                      ) : '—'}
                    </td>
                    <td className="hidden sm:table-cell px-4 py-2.5 text-center text-xs text-gray-400">{deal.quantity_available ?? '—'}</td>
                    <td className="px-4 py-2.5 text-center">
                      {isCommitted ? (
                        <span className="text-xs text-blue-400">Committed</span>
                      ) : (
                        <span className={`text-xs ${hasStock ? 'text-green-400' : 'text-gray-600'}`}>
                          {hasStock ? 'In Stock' : items ? 'Out of Stock' : '—'}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right text-gray-600 text-xs">
                      {expires && <span className="text-orange-400/70">{expires}</span>}
                      {deal.url && (
                        <a
                          href={deal.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={e => e.stopPropagation()}
                          className="ml-2 text-gray-600 hover:text-gray-400 transition-colors"
                        >
                          ↗
                        </a>
                      )}
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr>
                      <td colSpan={8} className="px-6 pb-4 pt-1">
                        {loadingItems && !items && (
                          <p className="text-xs text-gray-500 py-2">Loading items…</p>
                        )}
                        {itemsErr && (
                          <p className="text-xs text-red-400 py-2">{itemsErr}</p>
                        )}
                        {items && items.length === 0 && (
                          <p className="text-xs text-gray-500 py-2">No items found.</p>
                        )}
                        {items && items.length > 0 && (
                          <div className="space-y-2 pt-1">
                            {items.map(item => {
                              const alreadyCommitted = committedItemKeys.has(item.key);
                              const msg = actionMsg[item.key] ?? '';
                              const cost = parseFloat(item.current_cost);
                              const comm = parseFloat(item.commission);
                              const net = isNaN(cost) || isNaN(comm) ? null : cost - comm;
                              return (
                                <div key={item.key} className={`flex items-center gap-4 rounded-lg px-3 py-2 ${item.in_stock ? 'bg-green-950/30 border border-green-900/50' : 'bg-gray-900/40 border border-gray-800'}`}>
                                  {item.item_image_new && (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img src={item.item_image_new} alt="" className="w-12 h-12 object-contain rounded shrink-0" />
                                  )}
                                  <div className="flex-1 min-w-0">
                                    <p className="text-sm text-gray-200 font-medium truncate">{item.item_title}</p>
                                    <p className="text-xs text-gray-500">{item.item_model}</p>
                                    <div className="flex gap-3 mt-1 text-xs">
                                      <span className="text-gray-400">Cost <span className="font-mono text-white">{fmt(item.current_cost)}</span></span>
                                      <span className="text-gray-400">Commission <span className="font-mono text-green-400">{fmt(item.commission)}</span></span>
                                      {net !== null && <span className="text-gray-400">Your cost <span className={`font-mono ${net <= 0 ? 'text-green-400' : 'text-gray-200'}`}>{fmt(net)}</span></span>}
                                      {item.limit_user && <span className="text-yellow-400">limit {item.limit_user}/user</span>}
                                    </div>
                                  </div>
                                  <div className="flex flex-col items-end gap-1 shrink-0">
                                    <span className={`text-xs ${item.in_stock ? 'text-green-400' : 'text-gray-600'}`}>
                                      {item.in_stock ? '● In Stock' : '○ Out of Stock'}
                                    </span>
                                    {alreadyCommitted ? (
                                      <button
                                        onClick={() => {
                                          const c = commitments.find(c => c.item.key === item.key);
                                          if (c) cancelCommitment(deal.key, item.key);
                                        }}
                                        disabled={cancelling === deal.key}
                                        className="text-xs bg-red-900/40 hover:bg-red-900/60 border border-red-800 text-red-400 px-3 py-1 rounded transition-colors disabled:opacity-40"
                                      >
                                        {cancelling === deal.key ? 'Cancelling…' : 'Cancel'}
                                      </button>
                                    ) : (
                                      <button
                                        onClick={() => commit(deal.key, item.key)}
                                        disabled={!item.enabled || committing === item.key || isCommitted}
                                        className="text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white px-3 py-1 rounded transition-colors"
                                      >
                                        {committing === item.key ? 'Committing…' : 'Commit'}
                                      </button>
                                    )}
                                    {msg && <span className="text-xs text-green-400">{msg}</span>}
                                  </div>
                                </div>
                              );
                            })}
                            {myCommitment && (
                              <p className="text-xs text-gray-600 pt-1">Commitment ID: {myCommitment.commitment_id}</p>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </tbody>
              );
            })}
          </table>
        </div>
      )}
    </div>
  );
}
