'use client';

import { useEffect, useState, useMemo, useRef } from 'react';

type Deal = {
  id: number;
  title: string;
  slug: string;
  value: string;
  retail_type: string;
  retail_price: string | null;
  above_retail_amount: string | null;
  is_reservation_closed: number;
  other_retailers: number;
  status: string;
  closing_at?: string | null;
  reservation_deadline?: string | null;
  [key: string]: unknown;
};

type PortalRate = { id: number; merchant: string; category: string | null; portal: string; rate: string };

type DealItemLink = {
  vendor_name: string;
  in_stock: boolean;
  link_url: string;
  identifier: string;
};

type DealItem = {
  item_id: number;
  item_name?: string;
  max_can_reserve: number;
  is_reservation_closed: number;
  remaining_reservations: number;
  links?: DealItemLink[];
};

function fmt(n: string | null | undefined) {
  if (!n) return '—';
  const v = parseFloat(n);
  return isNaN(v) ? n : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v);
}

function fmtDate(s: string | null | undefined): string | null {
  if (!s) return null;
  try {
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch { return null; }
}

function RetailTypeBadge({ type }: { type: string }) {
  const cls =
    type === 'Above Retail' ? 'bg-green-900/50 text-green-300' :
    type === 'Full Retail'  ? 'bg-blue-900/50 text-blue-300' :
                              'bg-gray-800 text-gray-400';
  return <span className={`inline-flex px-1.5 py-0.5 rounded text-xs font-medium ${cls}`}>{type}</span>;
}

function DiffBadge({ value, retail }: { value: string; retail: string | null }) {
  if (!retail) return null;
  const v = parseFloat(value);
  const r = parseFloat(retail);
  if (isNaN(v) || isNaN(r) || r === 0) return null;
  const diff = v - r;
  const pct = (diff / r) * 100;
  const sign = diff >= 0 ? '+' : '';
  const cls = diff >= 0 ? 'text-green-400' : 'text-orange-400';
  const fmtDiff = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Math.abs(diff));
  return (
    <span className={`text-xs font-mono ${cls}`}>
      {diff >= 0 ? '+' : '-'}{fmtDiff} ({sign}{pct.toFixed(1)}%)
    </span>
  );
}

function bestRate(vendorName: string, rates: PortalRate[]): { rate: string; portal: string } | null {
  const matches = rates.filter(r => r.merchant.toLowerCase() === vendorName.toLowerCase() && !r.category);
  if (!matches.length) return null;
  const active = matches.filter(r => r.rate.toLowerCase() !== 'excluded');
  return active[0] ?? matches[0];
}

function DirectLinkButton({ linkUrl, vendorName, inStock, portalRates }: {
  linkUrl: string; vendorName: string; inStock: boolean; portalRates: PortalRate[];
}) {
  const [resolving, setResolving] = useState(false);
  const best = bestRate(vendorName, portalRates);
  const isExcluded = best?.rate.toLowerCase() === 'excluded';
  const cbmUrl = `https://www.cashbackmonitor.com/cashback-store/${vendorName.toLowerCase().replace(/\s+/g, '-')}/`;

  async function open() {
    setResolving(true);
    try {
      const res = await fetch(`/api/bfmr/resolve-link?url=${encodeURIComponent(linkUrl)}`);
      const { url } = await res.json() as { url: string };
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      window.open(linkUrl, '_blank', 'noopener,noreferrer');
    } finally {
      setResolving(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-1">
      <button
        onClick={open}
        disabled={resolving}
        className={`text-xs px-2 py-0.5 rounded border transition-colors disabled:opacity-50 ${
          inStock
            ? 'border-green-700 text-green-400 hover:bg-green-900/30'
            : 'border-gray-700 text-gray-500 hover:bg-gray-800'
        }`}
      >
        {resolving ? '…' : vendorName}{inStock ? ' ✓' : ''}
      </button>
      {best && (
        <span className={`text-xs font-mono ${isExcluded ? 'text-red-400' : 'text-blue-400'}`}
          title={`${best.portal}${isExcluded ? ' — excluded' : ''}`}>
          {isExcluded ? 'excl.' : best.rate}
        </span>
      )}
      {!best && (
        <a href={cbmUrl} target="_blank" rel="noopener noreferrer"
          className="text-xs text-gray-600 hover:text-gray-400 transition-colors" title="Check CashbackMonitor">
          cbm↗
        </a>
      )}
    </span>
  );
}

function WatchPanel({ deal, onWatching, portalRates, items, loadingItems, itemsError }: {
  deal: Deal;
  onWatching: () => void;
  portalRates: PortalRate[];
  items: DealItem[] | null;
  loadingItems: boolean;
  itemsError: string;
}) {
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null);
  const [qty, setQty] = useState(1);
  const [adding, setAdding] = useState(false);
  const [reserving, setReserving] = useState(false);
  const [addError, setAddError] = useState('');
  const [reserveResult, setReserveResult] = useState<{ reserved: boolean; available: boolean; message?: string } | null>(null);

  useEffect(() => {
    if (items?.length === 1) setSelectedItemId(items[0].item_id);
  }, [items]);

  async function addWatcher() {
    if (!selectedItemId) return;
    setAdding(true);
    setAddError('');
    try {
      const res = await fetch('/api/bfmr/watchers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dealSlug: deal.slug, itemId: selectedItemId, qty }),
      });
      if (!res.ok) { setAddError(await res.text()); return; }
      onWatching();
    } catch (e) {
      setAddError(String(e));
    } finally {
      setAdding(false);
    }
  }

  async function reserveNow() {
    if (!selectedItemId) return;
    setReserving(true);
    setReserveResult(null);
    setAddError('');
    try {
      const res = await fetch('/api/bfmr/reserve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dealSlug: deal.slug, itemId: selectedItemId, qty }),
      });
      const data = await res.json() as { reserved: boolean; available: boolean; qtyReserved?: number };
      setReserveResult({ reserved: data.reserved, available: data.available });
      if (data.reserved) onWatching();
    } catch (e) {
      setAddError(String(e));
    } finally {
      setReserving(false);
    }
  }

  if (loadingItems) return <p className="text-xs text-gray-500 py-2">Loading items…</p>;
  if (itemsError) return <p className="text-xs text-red-400 py-2">{itemsError}</p>;
  if (!items?.length) return <p className="text-xs text-gray-500 py-2">No items found.</p>;

  return (
    <div className="space-y-3 py-2">
      {reserveResult && (
        <div className={`text-xs px-3 py-2 rounded ${reserveResult.reserved ? 'bg-green-900/30 text-green-300 border border-green-800' : reserveResult.available ? 'bg-yellow-900/30 text-yellow-300 border border-yellow-800' : 'bg-gray-800 text-gray-400'}`}>
          {reserveResult.reserved ? 'Reserved!' : reserveResult.available ? 'Slots available but reservation failed — try again' : 'No slots available'}
        </div>
      )}
      <div className="space-y-1.5">
        {items.map(item => (
          <label key={item.item_id} className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="radio"
              name={`item-${deal.id}`}
              checked={selectedItemId === item.item_id}
              onChange={() => setSelectedItemId(item.item_id)}
              className="mt-0.5 shrink-0"
            />
            <div className="text-xs space-y-1">
              <div>
                <span className="text-gray-200">{item.item_name ?? `Item ${item.item_id}`}</span>
                <span className="ml-2 text-gray-500">
                  {item.is_reservation_closed === 1
                    ? <span className="text-red-400">Closed</span>
                    : item.max_can_reserve > 0
                      ? <span className="text-green-400">{item.max_can_reserve} available · {item.remaining_reservations} remaining</span>
                      : <span className="text-yellow-400">Open — at your cap</span>}
                </span>
              </div>
            </div>
          </label>
        ))}
      </div>

      <div className="flex items-center gap-2.5">
        <label className="text-xs text-gray-400">Qty</label>
        <input
          type="number" min={1} value={qty}
          onChange={e => setQty(Math.max(1, parseInt(e.target.value) || 1))}
          className="w-14 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
        />
        <button
          onClick={reserveNow}
          disabled={!selectedItemId || reserving || adding}
          className="text-xs bg-green-700 hover:bg-green-600 disabled:opacity-40 text-white px-3 py-1 rounded transition-colors"
        >
          {reserving ? 'Reserving…' : 'Reserve Now'}
        </button>
        <button
          onClick={addWatcher}
          disabled={!selectedItemId || adding || reserving}
          className="text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white px-3 py-1 rounded transition-colors"
        >
          {adding ? 'Adding…' : 'Watch'}
        </button>
        {addError && <span className="text-xs text-red-400">{addError}</span>}
      </div>
    </div>
  );
}

export default function DealsPage() {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [openOnly, setOpenOnly] = useState(true);
  const [retailFilter, setRetailFilter] = useState<string>('all');
  const [vendorFilter, setVendorFilter] = useState<string>('all');
  const [costFilter, setCostFilter] = useState<'all' | 'above' | 'below'>('all');
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null);
  const [watchedSlugs, setWatchedSlugs] = useState<Set<string>>(new Set());
  const [portalRates, setPortalRates] = useState<PortalRate[]>([]);
  const [ratesRefreshing, setRatesRefreshing] = useState(false);

  async function refreshRates() {
    setRatesRefreshing(true);
    try {
      const r = await fetch('/api/portal-rates');
      if (r.ok) setPortalRates(await r.json());
    } finally {
      setRatesRefreshing(false);
    }
  }

  // Pre-fetched deal items keyed by slug
  const [dealItems, setDealItems] = useState<Record<string, DealItem[]>>({});
  const [dealItemsLoading, setDealItemsLoading] = useState<Record<string, boolean>>({});
  const [dealItemsError, setDealItemsError] = useState<Record<string, string>>({});
  const prefetchStarted = useRef(false);

  useEffect(() => {
    refreshRates().catch(() => {});

    fetch('/api/bfmr/deals')
      .then(async r => {
        if (!r.ok) throw new Error(await r.text());
        return r.json() as Promise<Deal[]>;
      })
      .then(setDeals)
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));

    fetch('/api/bfmr/watchers')
      .then(r => r.ok ? r.json() : [])
      .then((ws: { dealSlug: string; active: boolean }[]) => {
        setWatchedSlugs(new Set(ws.filter(w => w.active).map(w => w.dealSlug)));
      })
      .catch(() => {});
  }, []);

  // Pre-fetch items for open deals in background (batches of 5)
  useEffect(() => {
    if (!deals.length || prefetchStarted.current) return;
    prefetchStarted.current = true;

    const openDeals = deals.filter(d => d.is_reservation_closed === 0);
    async function prefetch() {
      for (let i = 0; i < openDeals.length; i += 5) {
        const batch = openDeals.slice(i, i + 5);
        await Promise.all(batch.map(async deal => {
          setDealItemsLoading(prev => ({ ...prev, [deal.slug]: true }));
          try {
            const r = await fetch(`/api/bfmr/deal-items?slug=${encodeURIComponent(deal.slug)}`);
            if (!r.ok) throw new Error(await r.text());
            const data = await r.json() as { items: DealItem[] };
            setDealItems(prev => ({ ...prev, [deal.slug]: data.items }));
          } catch (e) {
            setDealItemsError(prev => ({ ...prev, [deal.slug]: String(e) }));
          } finally {
            setDealItemsLoading(prev => ({ ...prev, [deal.slug]: false }));
          }
        }));
      }
    }
    prefetch().catch(() => {});
  }, [deals]);

  const retailTypes = useMemo(() => [...new Set(deals.map(d => d.retail_type))].sort(), [deals]);

  // All unique vendor names from pre-loaded items
  const allVendors = useMemo(() => {
    const vendors = new Set<string>();
    for (const items of Object.values(dealItems)) {
      for (const item of items) {
        for (const link of item.links ?? []) {
          if (link.vendor_name) vendors.add(link.vendor_name);
        }
      }
    }
    return [...vendors].sort();
  }, [dealItems]);

  const filtered = useMemo(() => {
    return deals.filter(d => {
      if (openOnly && d.is_reservation_closed !== 0) return false;
      if (retailFilter !== 'all' && d.retail_type !== retailFilter) return false;

      if (costFilter !== 'all') {
        const v = parseFloat(d.value);
        const r = parseFloat(d.retail_price ?? '');
        if (!isNaN(v) && !isNaN(r)) {
          if (costFilter === 'above' && v < r) return false;
          if (costFilter === 'below' && v >= r) return false;
        }
      }

      if (vendorFilter !== 'all') {
        const items = dealItems[d.slug];
        if (!items) return true; // not yet loaded — keep visible
        const vendors = items.flatMap(i => i.links ?? []).map(l => l.vendor_name);
        if (!vendors.includes(vendorFilter)) return false;
      }

      if (search.trim()) {
        const q = search.toLowerCase();
        if (!d.title.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [deals, openOnly, retailFilter, vendorFilter, costFilter, search, dealItems]);

  // Unique vendors for the filtered set
  const filteredVendors = useMemo(() => {
    if (allVendors.length) return allVendors;
    return [];
  }, [allVendors]);

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">Deals</h1>
          <p className="text-gray-400 text-sm mt-1">{filtered.length} of {deals.length} deals</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <input
          type="text"
          placeholder="Search deals…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="bg-gray-900 border border-gray-700 rounded-md px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 w-48"
        />
        <label className="flex items-center gap-1.5 text-sm text-gray-300 cursor-pointer select-none">
          <input type="checkbox" checked={openOnly} onChange={e => setOpenOnly(e.target.checked)} />
          Open only
        </label>
        <select
          value={retailFilter}
          onChange={e => setRetailFilter(e.target.value)}
          className="bg-gray-900 border border-gray-700 rounded-md px-2 py-1.5 text-sm text-gray-300 focus:outline-none focus:border-blue-500"
        >
          <option value="all">All types</option>
          {retailTypes.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select
          value={costFilter}
          onChange={e => setCostFilter(e.target.value as 'all' | 'above' | 'below')}
          className="bg-gray-900 border border-gray-700 rounded-md px-2 py-1.5 text-sm text-gray-300 focus:outline-none focus:border-blue-500"
        >
          <option value="all">Any vs retail</option>
          <option value="above">At/Above Retail</option>
          <option value="below">Below Retail</option>
        </select>
        {filteredVendors.length > 0 && (
          <select
            value={vendorFilter}
            onChange={e => setVendorFilter(e.target.value)}
            className="bg-gray-900 border border-gray-700 rounded-md px-2 py-1.5 text-sm text-gray-300 focus:outline-none focus:border-blue-500"
          >
            <option value="all">All merchants</option>
            {filteredVendors.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        )}
        <button
          onClick={refreshRates}
          disabled={ratesRefreshing}
          className="ml-auto text-xs text-gray-500 hover:text-blue-400 disabled:opacity-40 transition-colors"
          title={portalRates.length ? `${portalRates.length} rates loaded` : 'No CBM rates loaded'}
        >
          {ratesRefreshing ? 'Refreshing…' : `↺ rates${portalRates.length ? ` (${portalRates.length})` : ''}`}
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
        <div className="rounded-lg border border-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-900 text-gray-500 text-xs uppercase">
              <tr>
                <th className="px-4 py-2 text-left">Deal</th>
                <th className="hidden sm:table-cell px-4 py-2 text-left">Type</th>
                <th className="px-4 py-2 text-right">Value</th>
                <th className="hidden md:table-cell px-4 py-2 text-right">vs Retail</th>
                <th className="px-4 py-2 text-center">Status</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {filtered.map(deal => {
                const isOpen = deal.is_reservation_closed === 0;
                const isExpanded = expandedSlug === deal.slug;
                const isWatched = watchedSlugs.has(deal.slug);
                const items = dealItems[deal.slug] ?? null;
                const loadingItems = dealItemsLoading[deal.slug] ?? false;
                const itemsError = dealItemsError[deal.slug] ?? '';

                // Inline vendor links from pre-loaded items
                const allLinks = items?.flatMap(i => i.links ?? []) ?? [];
                const uniqueLinks = allLinks.filter((l, i, arr) =>
                  arr.findIndex(x => x.vendor_name === l.vendor_name) === i
                );

                // Deadline
                const deadline = fmtDate(deal.closing_at as string ?? deal.reservation_deadline as string);

                return (
                  <>
                    <tr
                      key={deal.slug}
                      className={`hover:bg-gray-900/40 ${isExpanded ? 'bg-gray-900/60' : ''}`}
                    >
                      <td className="px-4 py-2.5 text-gray-200 font-medium max-w-xs">
                        <span className="truncate block">{deal.title}</span>
                        {loadingItems && !items && (
                          <span className="text-xs text-gray-600 mt-1 block">loading merchants…</span>
                        )}
                      </td>
                      <td className="hidden sm:table-cell px-4 py-2.5">
                        <RetailTypeBadge type={deal.retail_type} />
                      </td>
                      <td className="px-4 py-2.5 text-right text-green-400 font-mono">{fmt(deal.value)}</td>
                      <td className="hidden md:table-cell px-4 py-2.5 text-right">
                        <DiffBadge value={deal.value} retail={deal.retail_price} />
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <span className={`text-xs ${isOpen ? 'text-green-400' : 'text-gray-600'}`}>
                          {isOpen ? 'Open' : 'Closed'}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {isWatched ? (
                          <span className="text-xs text-blue-400">Watching</span>
                        ) : (
                          <button
                            onClick={() => setExpandedSlug(isExpanded ? null : deal.slug)}
                            className="text-xs bg-gray-800 hover:bg-blue-700 border border-gray-700 hover:border-blue-600 text-gray-300 hover:text-white px-3 py-1 rounded transition-colors"
                          >
                            {isExpanded ? 'Cancel' : 'Reserve'}
                          </button>
                        )}
                      </td>
                    </tr>
                    {(uniqueLinks.length > 0 || deadline) && (
                      <tr key={`${deal.slug}-links`} className="!border-t-0">
                        <td colSpan={6} className="px-4 pb-2 pt-0">
                          <div className="flex flex-wrap items-center gap-1.5">
                            {uniqueLinks.map((link, i) => (
                              <DirectLinkButton
                                key={i}
                                linkUrl={link.link_url}
                                vendorName={link.vendor_name}
                                inStock={link.in_stock}
                                portalRates={portalRates}
                              />
                            ))}
                            {deadline && (
                              <span className="text-xs text-orange-400 ml-auto">closes {deadline}</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                    {isExpanded && (
                      <tr key={`${deal.slug}-expand`} className="bg-gray-900/40">
                        <td colSpan={6} className="px-6 pb-3">
                          <WatchPanel
                            deal={deal}
                            portalRates={portalRates}
                            items={items}
                            loadingItems={loadingItems}
                            itemsError={itemsError}
                            onWatching={() => {
                              setWatchedSlugs(prev => new Set([...prev, deal.slug]));
                              setExpandedSlug(null);
                            }}
                          />
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
