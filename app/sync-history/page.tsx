'use client';

import { useEffect, useState, useMemo, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

type OrderChange = {
  id: number;
  orderId: number | null;
  orderNumber: string | null;
  action: 'created' | 'updated';
  changedFields: string;
};

type SyncEvent = {
  id: number;
  platform: string;
  scraped: number;
  imported: number;
  updated: number;
  skipped: number;
  createdAt: string;
  orderChanges: OrderChange[];
};

const FIELD_LABEL: Record<string, string> = {
  platform: 'Platform',
  orderNumber: 'Order #',
  itemDescription: 'Item',
  cost: 'Cost',
  shippingCost: 'Shipping',
  salePrice: 'Sale price',
  buyerId: 'Buyer',
  cardId: 'Card',
  cashbackAmount: 'Cashback',
  sourceUrl: 'Source URL',
  shippingAddress: 'Address',
  trackingNumbers: 'Tracking',
};

function fmtVal(v: unknown): string {
  if (v === null || v === undefined || v === '') return '∅';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v.length > 60 ? v.slice(0, 57) + '…' : v;
  return JSON.stringify(v);
}

function fmtTime(s: string) {
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function PLATFORM_COLOR(p: string): string {
  if (/amazon/i.test(p)) return 'text-orange-300';
  if (/walmart/i.test(p)) return 'text-blue-300';
  if (/costco/i.test(p)) return 'text-red-300';
  if (/bigsky/i.test(p)) return 'text-sky-300';
  return 'text-gray-300';
}

function ChangedFields({ json }: { json: string }) {
  let parsed: Record<string, [unknown, unknown]> = {};
  try { parsed = JSON.parse(json); } catch { /* ignore */ }
  const entries = Object.entries(parsed);
  if (entries.length === 0) return <span className="text-gray-600 text-xs">(no field changes)</span>;
  return (
    <div className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-xs">
      {entries.map(([f, [oldV, newV]]) => (
        <div key={f} className="contents">
          <span className="text-gray-400">{FIELD_LABEL[f] ?? f}</span>
          <span className="text-gray-200 break-all">
            <span className="text-gray-500">{fmtVal(oldV)}</span>
            <span className="text-gray-500"> → </span>
            <span>{fmtVal(newV)}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function SyncHistoryContent() {
  const params = useSearchParams();
  const focusEventParam = params.get('event');
  const focusEventId = focusEventParam ? parseInt(focusEventParam) : null;

  const [events, setEvents] = useState<SyncEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<number>>(new Set(focusEventId ? [focusEventId] : []));
  const [platform, setPlatform] = useState<string>('all');

  useEffect(() => {
    const qs = new URLSearchParams();
    if (platform !== 'all') qs.set('platform', platform);
    fetch(`/api/sync-history?${qs}`)
      .then(r => r.json())
      .then((d: SyncEvent[]) => { setEvents(Array.isArray(d) ? d : []); })
      .finally(() => setLoading(false));
  }, [platform]);

  const platforms = useMemo(() => {
    const set = new Set<string>();
    for (const e of events) set.add(e.platform);
    return ['all', ...[...set].sort()];
  }, [events]);

  function toggle(id: number) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Sync History</h1>
        <select
          value={platform}
          onChange={e => setPlatform(e.target.value)}
          className="bg-gray-900 border border-gray-700 rounded-md px-2 py-1.5 text-sm text-gray-300"
        >
          {platforms.map(p => <option key={p} value={p}>{p === 'all' ? 'All platforms' : p}</option>)}
        </select>
      </div>

      {loading ? (
        <div className="text-gray-500 text-sm py-8 text-center">Loading…</div>
      ) : events.length === 0 ? (
        <div className="text-gray-500 text-sm py-8 text-center">No sync events yet.</div>
      ) : (
        <div className="space-y-2">
          {events.map(e => {
            const isOpen = expanded.has(e.id);
            return (
              <div key={e.id} className="rounded-lg border border-gray-800 bg-gray-900/40">
                <button
                  onClick={() => toggle(e.id)}
                  className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-gray-900/60 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className={`text-sm font-semibold ${PLATFORM_COLOR(e.platform)}`}>{e.platform}</span>
                    <span className="text-xs text-gray-500">{fmtTime(e.createdAt)}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs">
                    {e.imported > 0 && <span className="text-emerald-300">{e.imported} new</span>}
                    {e.updated > 0 && <span className="text-blue-300">{e.updated} updated</span>}
                    {e.skipped > 0 && <span className="text-gray-500">{e.skipped} skipped</span>}
                    <span className="text-gray-600">{isOpen ? '▾' : '▸'}</span>
                  </div>
                </button>
                {isOpen && (() => {
                  const updatedWithChanges = e.orderChanges.filter(c => c.action === 'updated').length;
                  const createdWithChanges = e.orderChanges.filter(c => c.action === 'created').length;
                  const noChangeUpdates = Math.max(0, e.updated - updatedWithChanges);
                  return (
                  <div className="px-4 pb-4 border-t border-gray-800">
                    {(noChangeUpdates > 0 || e.orderChanges.length > 0) && (
                      <p className="text-xs text-gray-500 mt-3">
                        Of {e.imported + e.updated} order{e.imported + e.updated !== 1 ? 's' : ''} touched:{' '}
                        {createdWithChanges > 0 && <><span className="text-emerald-300">{createdWithChanges} created</span>{(updatedWithChanges > 0 || noChangeUpdates > 0) && ', '}</>}
                        {updatedWithChanges > 0 && <><span className="text-blue-300">{updatedWithChanges} updated with changes</span>{noChangeUpdates > 0 && ', '}</>}
                        {noChangeUpdates > 0 && <span className="text-gray-500">{noChangeUpdates} re-checked with no field changes</span>}.
                      </p>
                    )}
                    {e.orderChanges.length === 0 && noChangeUpdates === 0 ? (
                      <p className="text-xs text-gray-500 mt-3">No per-order detail captured.</p>
                    ) : e.orderChanges.length === 0 ? null : (
                      <div className="mt-3 space-y-3">
                        {e.orderChanges.map(c => (
                          <div key={c.id} className="border-l-2 border-gray-800 pl-3">
                            <div className="flex items-center gap-2 mb-1">
                              <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${
                                c.action === 'created' ? 'bg-emerald-900/50 text-emerald-300' : 'bg-blue-900/50 text-blue-300'
                              }`}>
                                {c.action}
                              </span>
                              {c.orderId ? (
                                <Link href={`/orders/${c.orderId}`} className="text-xs font-mono text-blue-400 hover:underline">
                                  #{c.orderNumber ?? c.orderId}
                                </Link>
                              ) : (
                                <span className="text-xs font-mono text-gray-500">#{c.orderNumber ?? '(deleted)'}</span>
                              )}
                            </div>
                            <ChangedFields json={c.changedFields} />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  );
                })()}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function SyncHistoryPage() {
  return (
    <Suspense fallback={<div className="text-gray-500 text-sm py-8 text-center">Loading…</div>}>
      <SyncHistoryContent />
    </Suspense>
  );
}
