'use client';

import { useEffect, useState, useMemo, useRef } from 'react';
import { useHideCashback } from '@/lib/useHideCashback';

type ItemStore = {
  store_slug: string;
  store_name: string;
  store_icon_new?: string;
  link?: string | null;
};

type DealItem = {
  key?: string;
  item_stores?: ItemStore[];
  [key: string]: unknown;
};

type BGDeal = {
  key: string;
  deal_id: string;
  title: string;
  image_new?: string;
  active: boolean;
  price: string;
  commission: string;
  old_price?: string | null;
  commit_required: boolean;
  commit_locked: boolean;
  is_special: boolean;
  expiry_day?: string;
  flags?: { slug: string; name: string; active: boolean }[];
  deal_item?: DealItem[];
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
  enabled: boolean;
};

type Commitment = {
  key: string;
  commitment_id: string;
  deal: { key: string; title: string; deal_id: string };
  item: { key: string; item_id: string };
};

type PortalRate = { id: number; merchant: string; category: string | null; portal: string; rate: string };

const POINTS_PORTALS = new Set(['rakuten']);

function rateValue(r: PortalRate, dealValue: number | null): string {
  const pct = parseFloat(r.rate) || 0;
  if (POINTS_PORTALS.has(r.portal.toLowerCase())) {
    const pts = Math.round(pct * (dealValue ?? 0));
    return pts > 0 ? `${Math.round(pct)}x pts (≈${pts} pts)` : `${Math.round(pct)}x pts`;
  }
  const dollar = dealValue !== null ? ` (≈$${((pct / 100) * dealValue).toFixed(2)})` : '';
  return `${pct}%${dollar}`;
}

function bestCashRate(storeName: string, rates: PortalRate[], ignoredPortals: string[]): PortalRate | null {
  const ignoredLower = ignoredPortals.map(p => p.toLowerCase());
  return rates
    .filter(r =>
      r.merchant.toLowerCase() === storeName.toLowerCase() &&
      !r.category &&
      !ignoredLower.includes(r.portal.toLowerCase()) &&
      !POINTS_PORTALS.has(r.portal.toLowerCase())
    )
    .sort((a, b) => (parseFloat(b.rate) || 0) - (parseFloat(a.rate) || 0))[0] ?? null;
}

function topRates(storeName: string, rates: PortalRate[], ignoredPortals: string[]): PortalRate[] {
  const ignoredLower = ignoredPortals.map(p => p.toLowerCase());
  const base = rates.filter(r =>
    r.merchant.toLowerCase() === storeName.toLowerCase() &&
    !r.category &&
    !ignoredLower.includes(r.portal.toLowerCase())
  );
  const pts = base.filter(r => POINTS_PORTALS.has(r.portal.toLowerCase()));
  const cash = base
    .filter(r => !POINTS_PORTALS.has(r.portal.toLowerCase()))
    .sort((a, b) => (parseFloat(b.rate) || 0) - (parseFloat(a.rate) || 0))
    .slice(0, 5);
  return [...pts, ...cash];
}

function StoreRateButton({ store, portalRates, ignoredPortals, dealValue }: {
  store: ItemStore;
  portalRates: PortalRate[];
  ignoredPortals: string[];
  dealValue: number | null;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [hideCashback] = useHideCashback();
  const rates = useMemo(() => topRates(store.store_name, portalRates, ignoredPortals), [store.store_name, portalRates, ignoredPortals]);
  const best = useMemo(() => bestCashRate(store.store_name, portalRates, ignoredPortals), [store.store_name, portalRates, ignoredPortals]);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const btn = (
    <button
      onClick={e => { e.stopPropagation(); if (rates.length) setOpen(o => !o); }}
      className={`text-xs px-2.5 py-1 rounded border transition-colors ${store.link ? 'border-blue-800 text-blue-400 hover:bg-blue-900/30 cursor-pointer' : 'border-gray-700 text-gray-500 cursor-default'}`}
    >
      {store.store_name}
      {best && !hideCashback && <span className="ml-1 text-green-400">{parseFloat(best.rate)}%</span>}
    </button>
  );

  if (!rates.length || hideCashback) return btn;

  return (
    <div ref={ref} className="relative inline-block">
      {btn}
      {open && (
        <div className="absolute z-[9999] bottom-full mb-1 left-0 bg-gray-900 border border-gray-700 rounded-lg shadow-xl min-w-[220px] max-h-64 overflow-y-auto py-1">
          <div className="px-3 py-1 text-xs text-gray-500 border-b border-gray-800 mb-1">{store.store_name} cashback</div>
          {rates.map(r => (
            <div key={r.id} className="flex justify-between px-3 py-1 text-xs hover:bg-gray-800">
              <span className="text-gray-300">{r.portal}</span>
              <span className="text-green-400 ml-4 shrink-0">{rateValue(r, dealValue)}</span>
            </div>
          ))}
          {store.link && (
            <div className="border-t border-gray-800 mt-1 px-3 py-1.5">
              <a href={store.link} target="_blank" rel="noopener noreferrer"
                className="text-xs text-blue-400 hover:text-blue-300"
                onClick={e => e.stopPropagation()}>
                Buy at {store.store_name} ↗
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function fmt(v: string | number | null | undefined) {
  const n = parseFloat(String(v ?? 0));
  if (isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function fmtExpiry(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (m) {
    const d = new Date(parseInt(m[3]), parseInt(m[1]) - 1, parseInt(m[2]));
    if (!isNaN(d.getTime())) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  return null;
}

function getOnlineStores(deal: BGDeal): ItemStore[] {
  const seen = new Map<string, ItemStore>();
  for (const di of deal.deal_item ?? []) {
    for (const s of di.item_stores ?? []) {
      if (s.link && !seen.has(s.store_slug)) seen.set(s.store_slug, s);
    }
  }
  return [...seen.values()];
}

export default function BgDealsPage() {
  const [deals, setDeals] = useState<BGDeal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [hideCashback, setHideCashback] = useHideCashback();
  const [dataType, setDataType] = useState<'active' | 'on_sale_now' | 'below_cost'>('active');
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [commitItems, setCommitItems] = useState<Record<string, CommitmentItem[]>>({});
  const [commitItemsLoading, setCommitItemsLoading] = useState<Record<string, boolean>>({});
  const [commitItemsError, setCommitItemsError] = useState<Record<string, string>>({});
  const [commitments, setCommitments] = useState<Commitment[]>([]);
  const [committing, setCommitting] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<Record<string, string>>({});
  const [portalRates, setPortalRates] = useState<PortalRate[]>([]);
  const [ignoredPortals, setIgnoredPortals] = useState<string[]>([]);
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

  useEffect(() => {
    fetch('/api/portal-rates').then(r => r.ok ? r.json() : []).then(setPortalRates).catch(() => {});
    fetch('/api/settings').then(r => r.ok ? r.json() : []).then((settings: { key: string; value: string }[]) => {
      const s = settings.find((x: { key: string }) => x.key === 'ignored_portals');
      if (s?.value) {
        try { setIgnoredPortals(JSON.parse(s.value)); } catch { /* ignore */ }
      }
    }).catch(() => {});
  }, []);

  // Pre-fetch commitment items for commit-required deals in background
  useEffect(() => {
    if (!deals.length || prefetchStarted.current) return;
    prefetchStarted.current = true;
    const active = deals.filter(d => d.active && !d.commit_locked && d.commit_required);
    async function prefetch() {
      for (let i = 0; i < active.length; i += 5) {
        await Promise.all(active.slice(i, i + 5).map(async deal => {
          if (commitItems[deal.key]) return;
          setCommitItemsLoading(prev => ({ ...prev, [deal.key]: true }));
          try {
            const r = await fetch(`/api/buyinggroup/commitment/items?dealKey=${encodeURIComponent(deal.key)}`);
            if (!r.ok) throw new Error(await r.text());
            const items = await r.json() as CommitmentItem[];
            setCommitItems(prev => ({ ...prev, [deal.key]: items }));
          } catch (e) {
            setCommitItemsError(prev => ({ ...prev, [deal.key]: String(e) }));
          } finally {
            setCommitItemsLoading(prev => ({ ...prev, [deal.key]: false }));
          }
        }));
      }
    }
    prefetch().catch(() => {});
  }, [deals]);

  const committedDealKeys = useMemo(() => new Set(commitments.map(c => c.deal.key)), [commitments]);
  const committedItemKeys = useMemo(() => new Set(commitments.map(c => c.item.key)), [commitments]);

  // Only show deals with at least one online store
  const onlineDeals = useMemo(() => deals.filter(d => getOnlineStores(d).length > 0), [deals]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return onlineDeals
      .filter(d => !q || d.title.toLowerCase().includes(q))
      .sort((a, b) => {
        const aStock = (commitItems[a.key] ?? []).some(i => i.in_stock);
        const bStock = (commitItems[b.key] ?? []).some(i => i.in_stock);
        if (bStock !== aStock) return bStock ? -1 : 1;
        const aCom = committedDealKeys.has(a.key);
        const bCom = committedDealKeys.has(b.key);
        if (bCom !== aCom) return bCom ? -1 : 1;
        return parseFloat(b.commission) - parseFloat(a.commission);
      });
  }, [onlineDeals, search, commitItems, committedDealKeys]);

  async function loadItemsForDeal(dealKey: string) {
    if (commitItems[dealKey]) return;
    setCommitItemsLoading(prev => ({ ...prev, [dealKey]: true }));
    try {
      const r = await fetch(`/api/buyinggroup/commitment/items?dealKey=${encodeURIComponent(dealKey)}`);
      if (!r.ok) throw new Error(await r.text());
      const items = await r.json() as CommitmentItem[];
      setCommitItems(prev => ({ ...prev, [dealKey]: items }));
    } catch (e) {
      setCommitItemsError(prev => ({ ...prev, [dealKey]: String(e) }));
    } finally {
      setCommitItemsLoading(prev => ({ ...prev, [dealKey]: false }));
    }
  }

  async function commit(dealKey: string, itemKey: string) {
    setCommitting(itemKey);
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
          <p className="text-gray-400 text-sm mt-1">{filtered.length} of {onlineDeals.length} deals</p>
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
          onChange={e => { setDataType(e.target.value as typeof dataType); setExpandedKey(null); }}
          className="bg-gray-900 border border-gray-700 rounded-md px-2 py-1.5 text-sm text-gray-300 focus:outline-none focus:border-blue-500"
        >
          <option value="active">All Active</option>
          <option value="on_sale_now">On Sale Now</option>
          <option value="below_cost">Below Cost</option>
        </select>
        <label className="flex items-center gap-1.5 text-sm text-gray-300 cursor-pointer select-none">
          <input type="checkbox" checked={hideCashback} onChange={e => setHideCashback(e.target.checked)} />
          Hide cashback
        </label>
        <button onClick={loadDeals} className="text-xs text-gray-500 hover:text-blue-400 transition-colors ml-auto">↺ Refresh</button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-900/20 px-4 py-3 text-sm text-red-300">{error}</div>
      )}

      {loading ? (
        <div className="text-center text-gray-500 py-12">Loading deals…</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-700 py-12 text-center text-gray-500">No deals found.</div>
      ) : (
        <div className="rounded-lg border border-gray-800 overflow-visible">
          <table className="w-full text-sm">
            <thead className="bg-gray-900 text-gray-500 text-xs uppercase">
              <tr>
                <th className="px-4 py-2 text-left rounded-tl-lg">Deal</th>
                <th className="hidden sm:table-cell px-4 py-2 text-left">Stores</th>
                <th className="px-4 py-2 text-right">Price</th>
                <th className="px-4 py-2 text-right">Commission</th>
                <th className="hidden md:table-cell px-4 py-2 text-right">Your Cost</th>
                <th className="px-4 py-2 text-center">Status</th>
                <th className="px-4 py-2 rounded-tr-lg"></th>
              </tr>
            </thead>
            {filtered.map(deal => {
              const isExpanded = expandedKey === deal.key;
              const items = commitItems[deal.key] ?? null;
              const loadingItems = commitItemsLoading[deal.key] ?? false;
              const itemsErr = commitItemsError[deal.key] ?? '';
              const isCommitted = committedDealKeys.has(deal.key);
              const myCommitment = commitments.find(c => c.deal.key === deal.key);
              const hasStock = (items ?? []).some(i => i.in_stock);
              const expires = fmtExpiry(deal.expiry_day);
              const price = parseFloat(deal.price);
              const commission = parseFloat(deal.commission);
              const yourCost = isNaN(price) || isNaN(commission) ? null : price - commission;
              const onlineStores = getOnlineStores(deal);
              const dealValue = yourCost !== null ? yourCost : price || null;

              return (
                <tbody key={deal.key} className="border-t border-gray-800">
                  <tr
                    className={`hover:bg-gray-900/40 cursor-pointer ${isExpanded ? 'bg-gray-900/60' : ''}`}
                    onClick={() => {
                      const next = isExpanded ? null : deal.key;
                      setExpandedKey(next);
                      if (next && deal.commit_required) loadItemsForDeal(next);
                    }}
                  >
                    <td className="px-4 py-2.5 text-gray-200 font-medium max-w-xs">
                      <div className="flex items-center gap-2">
                        <span className="truncate block">{deal.title.replace(/-/g, ' ')}</span>
                        {hasStock && <span className="shrink-0 text-xs text-green-400">●</span>}
                        {deal.is_special && <span className="shrink-0 text-xs bg-purple-900/50 text-purple-300 px-1 rounded">special</span>}
                      </div>
                    </td>
                    <td className="hidden sm:table-cell px-4 py-2.5">
                      <div className="flex gap-1 flex-wrap" onClick={e => e.stopPropagation()}>
                        {onlineStores.map(s => (
                          <StoreRateBadge key={s.store_slug} store={s} portalRates={portalRates} ignoredPortals={ignoredPortals} dealValue={dealValue} />
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs text-gray-300">{fmt(deal.price)}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs text-green-400">{fmt(deal.commission)}</td>
                    <td className="hidden md:table-cell px-4 py-2.5 text-right font-mono text-xs">
                      {yourCost !== null ? (
                        <span className={yourCost <= 0 ? 'text-green-400' : 'text-gray-300'}>{fmt(yourCost)}</span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-center text-xs">
                      {isCommitted ? (
                        <span className="text-blue-400">Committed</span>
                      ) : deal.commit_locked ? (
                        <span className="text-gray-600">Locked</span>
                      ) : hasStock ? (
                        <span className="text-green-400">In Stock</span>
                      ) : items ? (
                        <span className="text-gray-600">Out of Stock</span>
                      ) : (
                        <span className="text-gray-700">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right text-xs text-gray-600">
                      {expires && <span className="text-orange-400/70">{expires}</span>}
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr>
                      <td colSpan={7} className="px-6 pb-4 pt-1">
                        {!deal.commit_required ? (
                          <div className="flex flex-wrap gap-2 pt-1" onClick={e => e.stopPropagation()}>
                            {onlineStores.map(s => (
                              <StoreRateButton key={s.store_slug} store={s} portalRates={portalRates} ignoredPortals={ignoredPortals} dealValue={dealValue} />
                            ))}
                          </div>
                        ) : (
                          <>
                            {loadingItems && !items && <p className="text-xs text-gray-500 py-2">Loading items…</p>}
                            {itemsErr && <p className="text-xs text-red-400 py-2">{itemsErr}</p>}
                            {items && items.length === 0 && <p className="text-xs text-gray-500 py-2">No items found.</p>}
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
                                          {net !== null && <span className="text-gray-400">Net <span className={`font-mono ${net <= 0 ? 'text-green-400' : 'text-gray-200'}`}>{fmt(net)}</span></span>}
                                          {item.limit_user && <span className="text-yellow-400">limit {item.limit_user}/user</span>}
                                        </div>
                                        {/* Cashback rates for commit items — show per online store */}
                                        {onlineStores.length > 0 && (
                                          <div className="flex flex-wrap gap-1 mt-2" onClick={e => e.stopPropagation()}>
                                            {onlineStores.map(s => (
                                              <StoreRateBadge key={s.store_slug} store={s} portalRates={portalRates} ignoredPortals={ignoredPortals} dealValue={net ?? dealValue} />
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                      <div className="flex flex-col items-end gap-1 shrink-0">
                                        <span className={`text-xs ${item.in_stock ? 'text-green-400' : 'text-gray-600'}`}>
                                          {item.in_stock ? '● In Stock' : '○ Out of Stock'}
                                        </span>
                                        {alreadyCommitted ? (
                                          <button
                                            onClick={() => cancelCommitment(deal.key, item.key)}
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
                                  <p className="text-xs text-gray-600 pt-1">ID: {myCommitment.commitment_id}</p>
                                )}
                              </div>
                            )}
                          </>
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

// Small inline badge shown in the Stores column (no buy link, just rates popup)
function StoreRateBadge({ store, portalRates, ignoredPortals, dealValue }: {
  store: ItemStore;
  portalRates: PortalRate[];
  ignoredPortals: string[];
  dealValue: number | null;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const rates = useMemo(() => topRates(store.store_name, portalRates, ignoredPortals), [store.store_name, portalRates, ignoredPortals]);
  const best = useMemo(() => bestCashRate(store.store_name, portalRates, ignoredPortals), [store.store_name, portalRates, ignoredPortals]);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  return (
    <div ref={ref} className="relative inline-block">
      <button
        onClick={e => { e.stopPropagation(); if (rates.length) setOpen(o => !o); }}
        className={`text-xs px-1.5 py-0.5 rounded border transition-colors ${rates.length ? 'border-gray-600 hover:border-gray-500 cursor-pointer' : 'border-gray-800 cursor-default'} text-gray-400 bg-gray-800`}
      >
        {store.store_name}
        {best && <span className="ml-1 text-green-400">{parseFloat(best.rate)}%</span>}
      </button>
      {open && rates.length > 0 && (
        <div className="absolute z-[9999] bottom-full mb-1 left-0 bg-gray-900 border border-gray-700 rounded-lg shadow-xl min-w-[220px] max-h-64 overflow-y-auto py-1">
          <div className="px-3 py-1 text-xs text-gray-500 border-b border-gray-800 mb-1">{store.store_name} cashback</div>
          {rates.map(r => (
            <div key={r.id} className="flex justify-between px-3 py-1 text-xs hover:bg-gray-800">
              <span className="text-gray-300">{r.portal}</span>
              <span className="text-green-400 ml-4 shrink-0">{rateValue(r, dealValue)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
