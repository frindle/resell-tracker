'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { formatOrderDate, formatOrderDateIso } from '@/lib/formatOrderDate';

type PhotoOcr = {
  status: 'pending' | 'done' | 'error';
  kind: string | null;
  strength: 'exact' | 'likely' | 'ambiguous' | 'none' | null;
  suggestedOrderId: number | null;
  giftCardId: number | null;
  alternatives: string | null; // JSON number[]
  reason: string | null;
  error: string | null;
  giftCodes?: { code: string; merchant: string | null; label: 'pin' | 'code' }[];
  cardDefaults?: { merchant: string; value: number } | null;
};
type CodeRow = { code: string; read: string; include: boolean; merchant: string; value: string };
type UnassignedAttachment = { id: number; originalName: string; mimeType: string; createdAt: string; rotation: number; photoOcr?: PhotoOcr | null; uploadToken?: { name: string } | null };

function altIds(o: PhotoOcr | null | undefined): number[] {
  try { return o?.alternatives ? (JSON.parse(o.alternatives) as number[]) : []; } catch { return []; }
}

const BADGE: Record<string, { label: string; cls: string }> = {
  exact: { label: 'Match', cls: 'bg-green-700 text-green-50' },
  likely: { label: 'Likely', cls: 'bg-amber-600 text-amber-50' },
  ambiguous: { label: 'Pick one', cls: 'bg-gray-600 text-gray-100' },
};
type OrderOption = {
  id: number;
  platform: string;
  orderNumber: string | null;
  orderDate: string;
  itemDescription: string | null;
  buyer: { name: string } | null;
};

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic'];

// Calendar-day key for grouping. Shares lib/formatOrderDate with the date
// actually rendered on each row, so the key and the label can never disagree
// -- and, unlike a raw local-getter key, an imported date-only order keys to
// the day it was imported as rather than the previous evening.
const localDateKey = formatOrderDateIso;

export default function SortAssignPage() {
  const [photos, setPhotos] = useState<UnassignedAttachment[]>([]);
  const [orders, setOrders] = useState<OrderOption[]>([]);
  const [active, setActive] = useState<UnassignedAttachment | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [assigning, setAssigning] = useState(false);
  const [error, setError] = useState('');
  const [ocrEnabled, setOcrEnabled] = useState(false);
  const [autoAssign, setAutoAssign] = useState(false);
  const [notice, setNotice] = useState('');
  const [phoneOnly, setPhoneOnly] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [codeRows, setCodeRows] = useState<CodeRow[]>([]);

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

  useEffect(() => {
    load();
    fetch('/api/photo-ocr/settings').then(r => r.ok ? r.json() : null).then(s => {
      if (s) { setOcrEnabled(!!s.ocrEnabled); setAutoAssign(!!s.autoAssign); }
    });
  }, []);

  // While any photo is still being read, refresh the pool every few seconds
  // so suggestions (and auto-attached photos leaving) show up on their own.
  const scanning = photos.filter(p => p.photoOcr?.status === 'pending').length;
  useEffect(() => {
    if (!scanning) return;
    const t = setInterval(async () => {
      const res = await fetch('/api/orders/attachments/unassigned').then(r => r.json()).catch(() => null) as { attachments?: UnassignedAttachment[] } | null;
      if (res?.attachments) {
        setPhotos(res.attachments);
        setActive(prev => prev ? (res.attachments!.find(p => p.id === prev.id) ?? null) : prev);
      }
    }, 5000);
    return () => clearInterval(t);
  }, [scanning]);

  const orderById = useMemo(() => new Map(orders.map(o => [o.id, o])), [orders]);
  const exactMatches = photos.filter(p => p.photoOcr?.strength === 'exact' && p.photoOcr.suggestedOrderId != null);
  // Review queue: every photo OCR has an order for (exact or likely), oldest first.
  const toReview = photos.filter(p => (p.photoOcr?.strength === 'exact' || p.photoOcr?.strength === 'likely') && p.photoOcr.suggestedOrderId != null);

  // Gift codes read off the open photo, ready to edit before they're saved.
  const activeId = active?.id;
  useEffect(() => {
    const o = active?.photoOcr;
    setCodeRows((o?.giftCodes ?? []).map(g => ({
      code: g.code, read: g.code, include: true,
      merchant: g.merchant ?? o?.cardDefaults?.merchant ?? '',
      value: o?.cardDefaults?.value != null ? String(o.cardDefaults.value) : '',
    })));
    // Only when another photo opens (or its read finishes), not on every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, active?.photoOcr?.status]);

  function openNextReview(skipId?: number) {
    const next = toReview.find(p => p.id !== skipId && p.id !== activeId) ?? null;
    setActive(next);
    setZoomed(false);
    if (!next) { setReviewing(false); setNotice('Review queue is empty.'); }
  }

  async function rejectSuggestion() {
    if (!active) return;
    setError('');
    const res = await fetch(`/api/orders/attachments/unassigned/${active.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rejectSuggestion: true }),
    });
    if (!res.ok) { setError(await res.text().catch(() => `HTTP ${res.status}`)); return; }
    const ocr = await res.json() as PhotoOcr;
    const id = active.id;
    setPhotos(prev => prev.map(p => p.id === id ? { ...p, photoOcr: { ...p.photoOcr!, ...ocr, giftCodes: p.photoOcr?.giftCodes, cardDefaults: null } } : p));
    if (reviewing) openNextReview(id);
    else setActive(prev => prev ? { ...prev, photoOcr: { ...prev.photoOcr!, ...ocr, giftCodes: prev.photoOcr?.giftCodes, cardDefaults: null } } : prev);
  }

  /** Saves the ticked gift codes onto the order, then attaches the photo. */
  async function confirmTo(orderId: number) {
    const picked = codeRows.filter(r => r.include);
    for (const r of picked) {
      if (!r.code.trim() || !r.merchant.trim() || !(Number(r.value) > 0)) {
        setError('Each ticked code needs a merchant and a value — or untick it.');
        return;
      }
    }
    setError('');
    if (picked.length) {
      setAssigning(true);
      const res = await fetch(`/api/giftcard-ocr/orders/${orderId}/apply`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codes: picked.map(r => ({ cardNumber: r.code, merchant: r.merchant.trim(), value: Number(r.value), suggested: r.read })) }),
      });
      setAssigning(false);
      if (!res.ok) { setError(`Couldn't save the gift codes: ${await res.text().catch(() => `HTTP ${res.status}`)}`); return; }
    }
    await assign(orderId);
  }

  async function scan(rescan = false) {
    setNotice('');
    const res = await fetch('/api/photo-ocr/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rescan }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { setNotice(body.error ?? `HTTP ${res.status}`); return; }
    setNotice(body.queued ? `Reading ${body.queued} photo${body.queued === 1 ? '' : 's'}…` : 'Every photo has already been read.');
    await load();
  }

  async function attachExactMatches() {
    setNotice('');
    let done = 0;
    const failed: string[] = [];
    for (const p of exactMatches) {
      const res = await fetch(`/api/orders/attachments/unassigned/${p.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: p.photoOcr!.suggestedOrderId }),
      });
      if (res.ok) done++; else failed.push(p.originalName);
    }
    setPhotos(prev => prev.filter(p => !exactMatches.some(e => e.id === p.id) || failed.includes(p.originalName)));
    setNotice(`Attached ${done} photo${done === 1 ? '' : 's'}.${failed.length ? ` Couldn't attach: ${failed.join(', ')}` : ''}`);
  }

  async function toggleAutoAssign(next: boolean) {
    const res = await fetch('/api/photo-ocr/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoAssign: next }) });
    if (res.ok) setAutoAssign(next);
  }

  const groups = useMemo(() => Array.from(new Set(orders.map(o => o.buyer?.name).filter((n): n is string => !!n))).sort(), [orders]);
  const merchants = useMemo(() => Array.from(new Set(orders.map(o => o.platform))).sort(), [orders]);

  const allFilteredOrders = useMemo(() => {
    const q = search.trim().toLowerCase();
    return orders.filter(o => {
      if (group && o.buyer?.name !== group) return false;
      if (merchant && o.platform !== merchant) return false;
      // Compare local calendar days, not raw UTC -- an order placed in the
      // evening Pacific time can already be the next day in UTC, which made
      // this filter silently exclude orders whose on-screen date (rendered
      // via toLocaleDateString() below, also local) matched exactly what was
      // typed into the date filter.
      if (date && localDateKey(o.orderDate) !== date) return false;
      if (q) {
        const hay = `${o.itemDescription ?? ''} ${o.orderNumber ?? ''} ${o.platform} ${o.buyer?.name ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [orders, group, merchant, date, search]);
  const filteredOrders = allFilteredOrders.slice(0, 50);

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
        if (reviewing) openNextReview(active.id); else setActive(null);
        setGroup(''); setMerchant(''); setDate(''); setSearch('');
      } else {
        setError(await res.text().catch(() => `HTTP ${res.status}`));
      }
    } finally {
      setAssigning(false);
    }
  }

  // Rotates the photo 90° clockwise and persists it -- the grid thumbnail
  // bakes rotation into the served bytes server-side (see makeThumbnail in
  // the API route), so it just needs a fresh fetch; the full-size previews
  // (triage modal, zoom) apply it client-side via CSS transform instead,
  // since they intentionally serve the untouched original.
  async function rotate() {
    if (!active) return;
    const next = ((active.rotation + 90) % 360) as 0 | 90 | 180 | 270;
    const res = await fetch(`/api/orders/attachments/unassigned/${active.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rotation: next }),
    });
    if (res.ok) {
      setPhotos(prev => prev.map(p => p.id === active.id ? { ...p, rotation: next } : p));
      setActive(prev => prev ? { ...prev, rotation: next } : prev);
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
          {ocrEnabled && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <button onClick={() => scan(false)} className="px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200">Read new photos</button>
              <button onClick={() => scan(true)} className="px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-400">Re-read all</button>
              {toReview.length > 0 && (
                <button onClick={() => { setReviewing(true); setActive(toReview[0]); setZoomed(false); }} className="px-3 py-1.5 rounded bg-blue-700 hover:bg-blue-600 text-white">
                  Review {toReview.length} match{toReview.length === 1 ? '' : 'es'}
                </button>
              )}
              {exactMatches.length > 0 && (
                <button onClick={attachExactMatches} className="px-3 py-1.5 rounded bg-green-700 hover:bg-green-600 text-white">
                  Attach {exactMatches.length} exact match{exactMatches.length === 1 ? '' : 'es'}
                </button>
              )}
              {scanning > 0 && <span className="text-xs text-gray-500">Reading {scanning}…</span>}
              <label className="ml-auto flex items-center gap-1.5 text-xs text-gray-400" title="Attach a photo on its own when its card number or order number matches exactly one order">
                <input type="checkbox" checked={autoAssign} onChange={e => toggleAutoAssign(e.target.checked)} />
                Attach exact matches automatically
              </label>
            </div>
          )}
          {notice && <p className="text-xs text-gray-400">{notice}</p>}
          {photos.some(p => p.uploadToken) && (
            <label className="flex items-center gap-1.5 text-xs text-gray-400">
              <input type="checkbox" checked={phoneOnly} onChange={e => setPhoneOnly(e.target.checked)} />
              Only show phone uploads ({photos.filter(p => p.uploadToken).length})
            </label>
          )}
          <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
            {photos.filter(p => !phoneOnly || p.uploadToken).map(p => {
              const isImage = IMAGE_TYPES.includes(p.mimeType);
              const url = `/api/orders/attachments/unassigned/${p.id}`;
              return (
                <div key={p.id} className="relative group">
                  <button onClick={() => setActive(p)} className="block w-full">
                    {isImage ? (
                      <img src={`${url}?thumb=1&r=${p.rotation}`} loading="lazy" alt={p.originalName} className="aspect-square w-full object-cover rounded border border-gray-700 hover:border-blue-500 transition-colors" />
                    ) : (
                      <div className="aspect-square w-full flex items-center justify-center bg-gray-800 border border-gray-700 rounded text-2xl">📎</div>
                    )}
                  </button>
                  {p.uploadToken && (
                    <span title={`From ${p.uploadToken.name}`} className="absolute top-1 left-1 px-1.5 rounded text-[10px] bg-blue-700/90 text-blue-50">Phone</span>
                  )}
                  {p.photoOcr?.status === 'pending' && (
                    <span className="absolute bottom-1 left-1 px-1.5 rounded text-[10px] bg-black/70 text-gray-300">Reading…</span>
                  )}
                  {p.photoOcr?.status === 'done' && p.photoOcr.strength && BADGE[p.photoOcr.strength] && (
                    <span className={`absolute bottom-1 left-1 px-1.5 rounded text-[10px] ${BADGE[p.photoOcr.strength].cls}`}>{BADGE[p.photoOcr.strength].label}</span>
                  )}
                  {p.photoOcr?.status === 'done' && !(p.photoOcr.strength && BADGE[p.photoOcr.strength]) && (
                    <span title={p.photoOcr.reason || 'Read, but no order matched'} className="absolute bottom-1 left-1 px-1.5 rounded text-[10px] bg-black/70 text-gray-400">No match</span>
                  )}
                  {p.photoOcr?.status === 'error' && (
                    <span title={p.photoOcr.error || ''} className="absolute bottom-1 left-1 px-1.5 rounded text-[10px] bg-red-800/90 text-red-50">Couldn't read</span>
                  )}
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => { setActive(null); setZoomed(false); }}>
          <div className="bg-gray-900 border border-gray-700 rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto p-5 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-start gap-4">
              {IMAGE_TYPES.includes(active.mimeType) ? (
                <button onClick={() => setZoomed(true)} className="shrink-0 cursor-zoom-in">
                  <img
                    src={`/api/orders/attachments/unassigned/${active.id}`}
                    alt={active.originalName}
                    style={{ transform: `rotate(${active.rotation}deg)` }}
                    className="w-40 h-40 object-contain rounded border border-gray-700 bg-black/30"
                  />
                </button>
              ) : (
                <div className="w-40 h-40 flex items-center justify-center bg-gray-800 border border-gray-700 rounded text-4xl">📎</div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm text-gray-300 truncate">{active.originalName}</p>
                <p className="text-xs text-gray-500">
                  {active.uploadToken ? `From ${active.uploadToken.name}` : 'Uploaded in the browser'}, {new Date(active.createdAt).toLocaleString()}
                </p>
                <button onClick={() => { setActive(null); setZoomed(false); setReviewing(false); }} className="text-xs text-gray-500 hover:text-gray-300 mt-1">Close</button>
                {reviewing && <p className="text-xs text-blue-300 mt-1">Reviewing matches: {toReview.length} left</p>}
              </div>
            </div>

            {active.photoOcr && (() => {
              const o = active.photoOcr;
              if (o.status === 'pending') return <p className="text-xs text-gray-500">Reading this photo…</p>;
              if (o.status === 'error') return <p className="text-xs text-red-400">Couldn't read this photo: {o.error}</p>;
              const ids = [o.suggestedOrderId, ...altIds(o)].filter((x): x is number => x != null && orderById.has(x));
              return (
                <div className="rounded border border-gray-700 p-3 space-y-2">
                  <p className="text-xs text-gray-400">
                    {o.strength === 'exact' ? 'Matched' : o.strength === 'likely' ? 'Likely match' : o.strength === 'ambiguous' ? 'Could be one of these' : 'No match'}
                    {o.reason ? `: ${o.reason}` : ''}
                  </p>
                  {ids.map((id, i) => {
                    const ord = orderById.get(id)!;
                    const primary = i === 0 && id === o.suggestedOrderId;
                    return (
                      <button key={id} disabled={assigning} onClick={() => confirmTo(id)}
                        className={`w-full text-left px-3 py-2 rounded disabled:opacity-50 border text-sm transition-colors ${primary ? 'bg-green-900/40 border-green-700 hover:bg-green-900/70' : 'bg-gray-800 border-gray-700 hover:border-blue-500'}`}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-gray-200 truncate">{ord.itemDescription || '—'}</span>
                          <span className="text-xs text-gray-500 shrink-0">{formatOrderDate(ord.orderDate, { dateOnly: true })}</span>
                        </div>
                        <div className="text-xs text-gray-500 truncate">{ord.platform} {ord.buyer?.name ? `· ${ord.buyer.name}` : ''} {ord.orderNumber ? `· #${ord.orderNumber}` : ''}{primary ? ` · Confirm and attach${codeRows.some(r => r.include) ? ` with ${codeRows.filter(r => r.include).length} gift code${codeRows.filter(r => r.include).length === 1 ? '' : 's'}` : ''}` : ''}</div>
                      </button>
                    );
                  })}
                  {o.suggestedOrderId != null && (
                    <div className="flex gap-2">
                      <button disabled={assigning} onClick={rejectSuggestion} className="flex-1 px-3 py-1.5 rounded border border-gray-700 bg-gray-800 hover:border-red-500 text-xs text-gray-300 disabled:opacity-50">Not this order</button>
                      {reviewing && <button onClick={() => openNextReview(active.id)} className="flex-1 px-3 py-1.5 rounded border border-gray-700 bg-gray-800 hover:border-gray-500 text-xs text-gray-400">Skip</button>}
                    </div>
                  )}
                  {codeRows.length > 0 && (
                    <div className="space-y-1.5 pt-1">
                      <p className="text-xs text-gray-400">Gift codes read off this photo. Check each against the photo; ticked ones are added to the order you attach to.</p>
                      {codeRows.map((r, i) => {
                        const set = (patch: Partial<CodeRow>) => setCodeRows(rows => rows.map((x, j) => j === i ? { ...x, ...patch } : x));
                        return (
                          <div key={r.read} className="flex items-center gap-1.5">
                            <input type="checkbox" checked={r.include} onChange={e => set({ include: e.target.checked })} aria-label="Add this code" />
                            <input value={r.code} onChange={e => set({ code: e.target.value.toUpperCase().replace(/\s+/g, '') })}
                              className="flex-1 min-w-0 font-mono bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-100" aria-label="Gift code" />
                            <input value={r.merchant} onChange={e => set({ merchant: e.target.value })} placeholder="Merchant"
                              className="w-24 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200" aria-label="Merchant" />
                            <input value={r.value} onChange={e => set({ value: e.target.value })} placeholder="$" inputMode="decimal"
                              className="w-16 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200" aria-label="Value" />
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {o.strength !== 'exact' && (
                    <a href={`/orders/new?photo=${active.id}`}
                      className="block w-full text-center px-3 py-2 rounded border border-gray-700 bg-gray-800 hover:border-blue-500 text-sm text-gray-200">
                      Create a new order from this photo
                    </a>
                  )}
                </div>
              );
            })()}

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

            {allFilteredOrders.length > filteredOrders.length && (
              <p className="text-xs text-amber-400">
                Showing {filteredOrders.length} of {allFilteredOrders.length} matches — narrow down the filters to find more.
              </p>
            )}

            <div className="space-y-1 max-h-72 overflow-y-auto">
              {filteredOrders.length === 0 ? (
                <p className="text-xs text-gray-500 py-4 text-center">No matching orders — narrow down less, or check the filters.</p>
              ) : filteredOrders.map(o => (
                <button
                  key={o.id}
                  disabled={assigning}
                  onClick={() => confirmTo(o.id)}
                  className="w-full text-left px-3 py-2 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-50 border border-gray-700 hover:border-blue-500 transition-colors text-sm"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-gray-200 truncate">{o.itemDescription || '—'}</span>
                    <span className="text-xs text-gray-500 shrink-0">{formatOrderDate(o.orderDate, { dateOnly: true })}</span>
                  </div>
                  <div className="text-xs text-gray-500 truncate">{o.platform} {o.buyer?.name ? `· ${o.buyer.name}` : ''} {o.orderNumber ? `· #${o.orderNumber}` : ''}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {zoomed && active && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80" onClick={() => setZoomed(false)}>
          <div className="relative max-w-4xl max-h-[90vh]" onClick={e => e.stopPropagation()}>
            <img
              src={`/api/orders/attachments/unassigned/${active.id}`}
              alt={active.originalName}
              style={{ transform: `rotate(${active.rotation}deg)` }}
              className="max-w-full max-h-[90vh] object-contain rounded"
            />
            <button
              onClick={rotate}
              title="Rotate 90°"
              className="absolute top-2 right-12 bg-black/60 hover:bg-black/80 text-white rounded-full w-8 h-8 flex items-center justify-center text-lg"
            >⟳</button>
            <button onClick={() => setZoomed(false)} className="absolute top-2 right-2 bg-black/60 hover:bg-black/80 text-white rounded-full w-8 h-8 flex items-center justify-center text-lg">×</button>
            <p className="text-center text-xs text-gray-400 mt-2">{active.originalName}</p>
          </div>
        </div>
      )}
    </div>
  );
}
