'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { formatOrderDate, formatOrderDateIso } from '@/lib/formatOrderDate';

type PhotoOcr = {
  status: 'pending' | 'done' | 'error' | 'stopped';
  kind: string | null;
  strength: 'exact' | 'likely' | 'ambiguous' | 'none' | null;
  suggestedOrderId: number | null;
  giftCardId: number | null;
  alternatives: string | null; // JSON number[]
  reason: string | null;
  error: string | null;
  giftCodes?: { code: string; merchant: string | null; label: 'pin' | 'code' }[];
  cardDefaults?: { merchant: string; value: number } | null;
  /** A new order filled in from the photo when it matched none. Not saved until confirmed. */
  draft?: Draft | null;
  /** Crops of the lines the draft's store, amount and order number came from. */
  draftSnips?: [number, number, number, number][];
  /** What the match rests on, to check against the photo. */
  evidence?: {
    cardNumber: string | null; orderNumber: string | null; matchedLines: string[]; locked: boolean;
    snips?: [number, number, number, number][];
    order?: {
      id: number; orderNumber: string | null; platform: string; orderDate: string; cost: number; itemDescription: string | null;
      group: string | null; paidWith: string | null; giftCards: { id: number; cardNumber: string; value: number; merchant: string }[];
    } | null;
  } | null;
  /** Every line OCR read off the photo. */
  lines?: string[];
  /** Rejected in quick review: left for sorting by hand. */
  manual?: boolean;
};
type Draft = { platform: string; orderNumber: string | null; orderDate: string; cost: string; cardId: number | null; itemDescription: string | null };
type DraftForm = { platform: string; orderNumber: string; orderDate: string; cost: string; cardId: string; buyerId: string; itemDescription: string };
type CodeRow = { code: string; read: string; include: boolean; merchant: string; value: string };
type OcrQueue = { waiting: number; current: { id: number; seconds: number } | null };
type UnassignedAttachment = { id: number; originalName: string; mimeType: string; createdAt: string; rotation: number; photoOcr?: PhotoOcr | null; uploadToken?: { name: string } | null };

/** Quick review order: exact matches, then drafted new orders, then probable matches. */
function quickRank(o: PhotoOcr): number {
  return o.strength === 'exact' && o.suggestedOrderId != null ? 0 : o.draft ? 1 : 2;
}

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
  const [manualOnly, setManualOnly] = useState(false);
  const [quick, setQuick] = useState(false);
  const [quickSkipped, setQuickSkipped] = useState<number[]>([]);
  const [quickWhole, setQuickWhole] = useState(false);
  const [quickBusy, setQuickBusy] = useState(false);
  const [quickStats, setQuickStats] = useState({ accepted: 0, rejected: 0 });
  const [reviewing, setReviewing] = useState(false);
  const [codeRows, setCodeRows] = useState<CodeRow[]>([]);
  const [draftForm, setDraftForm] = useState<DraftForm | null>(null);
  const [buyers, setBuyers] = useState<{ id: number; name: string }[]>([]);
  const [cards, setCards] = useState<{ id: number; name: string; last4: string | null }[]>([]);

  // Picker filters -- group, merchant, date, and free-text all narrow the
  // same order list together (AND, not OR).
  const [group, setGroup] = useState('');
  const [merchant, setMerchant] = useState('');
  const [date, setDate] = useState('');
  const [search, setSearch] = useState('');
  const [ocrQueue, setOcrQueue] = useState<OcrQueue | null>(null);

  async function load() {
    setLoading(true);
    const [photosRes, ordersRes] = await Promise.all([
      fetch('/api/orders/attachments/unassigned').then(r => r.json()) as Promise<{ attachments: UnassignedAttachment[]; ocrQueue?: OcrQueue }>,
      fetch('/api/orders?all=1').then(r => r.json()) as Promise<OrderOption[]>,
    ]);
    setPhotos(photosRes.attachments ?? []);
    setOcrQueue(photosRes.ocrQueue ?? null);
    setOrders(Array.isArray(ordersRes) ? ordersRes : []);
    setLoading(false);
  }

  useEffect(() => {
    load();
    fetch('/api/buyers').then(r => r.ok ? r.json() : []).then(b => setBuyers(Array.isArray(b) ? b.map((x: { id: number; name: string }) => ({ id: x.id, name: x.name })) : []));
    fetch('/api/cards').then(r => r.ok ? r.json() : []).then(c => setCards(Array.isArray(c) ? c.map((x: { id: number; name: string; last4: string | null }) => ({ id: x.id, name: x.name, last4: x.last4 })) : []));
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
      const res = await fetch('/api/orders/attachments/unassigned').then(r => r.json()).catch(() => null) as { attachments?: UnassignedAttachment[]; ocrQueue?: OcrQueue } | null;
      if (res?.attachments) {
        setPhotos(res.attachments);
        setOcrQueue(res.ocrQueue ?? null);
        setActive(prev => prev ? (res.attachments!.find(p => p.id === prev.id) ?? null) : prev);
      }
    }, 5000);
    return () => clearInterval(t);
  }, [scanning]);

  const orderById = useMemo(() => new Map(orders.map(o => [o.id, o])), [orders]);
  const exactMatches = photos.filter(p => p.photoOcr?.strength === 'exact' && p.photoOcr.suggestedOrderId != null);
  // Review queue: every photo OCR has an order for (exact or likely), oldest first.
  // Plus photos that matched nothing but carried enough to draft a new order.
  // Quick review: one matched photo at a time, exact matches first.
  const quickQueue = photos
    .filter(p => p.photoOcr?.status === 'done' && !p.photoOcr.manual && ((p.photoOcr.suggestedOrderId != null && p.photoOcr.evidence?.order) || p.photoOcr.draft))
    // Exact matches, then new orders (card photos from the same trip can only
    // match one once it exists), then probable matches.
    .sort((a, b) => quickRank(a.photoOcr!) - quickRank(b.photoOcr!));
  const quickCurrent = quickQueue.find(p => !quickSkipped.includes(p.id)) ?? null;
  const manualCount = photos.filter(p => p.photoOcr?.manual).length;

  /**
   * A new order was just made from a photo: every other drafted photo may be
   * the same purchase, so take them out of review until they are read again
   * against it (the re-read runs right after). Stops a second copy being made.
   */
  function holdOtherDrafts(exceptId: number) {
    setPhotos(prev => prev.map(x => x.id !== exceptId && x.photoOcr?.draft
      ? { ...x, photoOcr: { ...x.photoOcr, status: 'pending', draft: null } }
      : x));
  }

  async function quickDecide(accept: boolean) {
    const p = quickCurrent;
    const draft = p?.photoOcr?.draft ?? null;
    const ord = p?.photoOcr?.evidence?.order;
    if (!p || (!ord && !draft) || quickBusy) return;
    setQuickBusy(true);
    setError('');
    let orderId = ord?.id ?? null;
    if (accept && !ord && draft) {
      // A drafted new order: create it as read, then attach the photo.
      const made = await fetch('/api/orders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: draft.platform, orderNumber: draft.orderNumber, orderDate: draft.orderDate,
          cost: draft.cost, cardId: draft.cardId, buyerId: null, itemDescription: draft.itemDescription, fromPhoto: true,
        }),
      });
      const body = await made.json().catch(() => ({})) as { id?: number; platform?: string; orderNumber?: string | null; orderDate?: string; itemDescription?: string | null; error?: string; existing?: boolean };
      if (!made.ok || !body.id) {
        setQuickBusy(false);
        setError(`Couldn't create the order: ${body.error ?? `HTTP ${made.status}`}`);
        return;
      }
      orderId = body.id;
      holdOtherDrafts(p.id);
      if (!body.existing) setOrders(prev => [...prev, { id: body.id!, platform: body.platform ?? draft.platform, orderNumber: body.orderNumber ?? null, orderDate: body.orderDate ?? draft.orderDate, itemDescription: body.itemDescription ?? null, buyer: null }]);
    }
    const res = await fetch(`/api/orders/attachments/unassigned/${p.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(accept ? { orderId } : { rejectSuggestion: true, manual: true }),
    });
    setQuickBusy(false);
    if (!res.ok) {
      const b = await res.json().catch(() => null) as { error?: string } | null;
      setError(`Couldn't ${accept ? 'attach' : 'set aside'} that photo: ${b?.error ?? `HTTP ${res.status}`}`);
      return;
    }
    if (accept) {
      setPhotos(prev => prev.filter(x => x.id !== p.id));
      if (!ord) {
        // Card photos from the same trip can now match the new order.
        fetch('/api/photo-ocr/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unmatched: true }) })
          .then(() => load()).catch(() => {});
      }
    } else {
      setPhotos(prev => prev.map(x => x.id === p.id && x.photoOcr ? { ...x, photoOcr: { ...x.photoOcr, manual: true, suggestedOrderId: null, strength: 'none', evidence: null, draft: null } } : x));
    }
    setQuickStats(s => accept ? { ...s, accepted: s.accepted + 1 } : { ...s, rejected: s.rejected + 1 });
  }

  useEffect(() => {
    if (!quick) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const k = e.key.toLowerCase();
      if (k === 'a') { e.preventDefault(); quickDecide(true); }
      else if (k === 'r') { e.preventDefault(); quickDecide(false); }
      else if (k === 's' && quickCurrent) { e.preventDefault(); setQuickSkipped(s => [...s, quickCurrent.id]); }
      else if (k === 'f') { e.preventDefault(); setQuickWhole(w => !w); }
      else if (k === 'escape') setQuick(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const toReview = photos.filter(p => ((p.photoOcr?.strength === 'exact' || p.photoOcr?.strength === 'likely') && p.photoOcr.suggestedOrderId != null) || !!p.photoOcr?.draft);

  // Gift codes read off the open photo, ready to edit before they're saved.
  const activeId = active?.id;
  useEffect(() => {
    const o = active?.photoOcr;
    setCodeRows((o?.giftCodes ?? []).map(g => ({
      code: g.code, read: g.code, include: true,
      merchant: g.merchant ?? o?.cardDefaults?.merchant ?? '',
      value: o?.cardDefaults?.value != null ? String(o.cardDefaults.value) : '',
    })));
    const d = o?.draft;
    setDraftForm(d ? {
      platform: d.platform, orderNumber: d.orderNumber ?? '', orderDate: d.orderDate, cost: d.cost,
      cardId: d.cardId != null ? String(d.cardId) : '', buyerId: '', itemDescription: d.itemDescription ?? '',
    } : null);
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
    const ocr = { ...(await res.json() as PhotoOcr), draft: null };
    const id = active.id;
    setPhotos(prev => prev.map(p => p.id === id ? { ...p, photoOcr: { ...p.photoOcr!, ...ocr, giftCodes: p.photoOcr?.giftCodes, cardDefaults: null } } : p));
    if (reviewing) openNextReview(id);
    else setActive(prev => prev ? { ...prev, photoOcr: { ...prev.photoOcr!, ...ocr, giftCodes: prev.photoOcr?.giftCodes, cardDefaults: null } } : prev);
  }

  /** The ticked gift codes, or null (with the error shown) when one is incomplete. */
  function pickedCodes(): CodeRow[] | null {
    const picked = codeRows.filter(r => r.include);
    if (picked.some(r => !r.code.trim() || !r.merchant.trim() || !(Number(r.value) > 0))) {
      setError('Each ticked code needs a merchant and a value — or untick it.');
      return null;
    }
    return picked;
  }

  /** Saves the ticked gift codes onto the order, then attaches the photo. */
  async function confirmTo(orderId: number) {
    const picked = pickedCodes();
    if (!picked) return;
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

  /** Creates the drafted order, attaches this photo (and ticked codes), then re-reads unmatched photos against it. */
  async function createFromDraft() {
    const f = draftForm;
    if (!f || !active) return;
    if (!f.platform.trim() || !f.orderDate || !(Number(f.cost) > 0)) { setError('A new order needs a store, a date and a cost.'); return; }
    // Check the codes before the order exists, so a fix-and-retry can't create it twice.
    if (!pickedCodes()) return;
    setError('');
    setAssigning(true);
    const res = await fetch('/api/orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: f.platform.trim(), orderNumber: f.orderNumber.trim() || null, orderDate: f.orderDate,
        cost: f.cost, cardId: f.cardId || null, buyerId: f.buyerId || null, itemDescription: f.itemDescription.trim() || null,
        fromPhoto: true,
      }),
    });
    setAssigning(false);
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.id) { setError(`Couldn't create the order: ${body.error ?? `HTTP ${res.status}`}`); return; }
    holdOtherDrafts(active.id);
    if (body.existing) setNotice(`That order already existed (from another photo), so this photo was added to it.`);
    else setOrders(prev => [...prev, { id: body.id, platform: body.platform, orderNumber: body.orderNumber, orderDate: body.orderDate, itemDescription: body.itemDescription, buyer: body.buyer ? { name: body.buyer.name } : null }]);
    await confirmTo(body.id);
    // Card photos from the same trip can now match the new order.
    fetch('/api/photo-ocr/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unmatched: true }) })
      .then(() => load()).catch(() => {});
  }

  async function scan(rescan = false) {
    setNotice('');
    const res = await fetch('/api/photo-ocr/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rescan }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { setNotice(body.error ?? `HTTP ${res.status}`); return; }
    setNotice(body.queued ? `Reading ${body.queued} photo${body.queued === 1 ? '' : 's'}…` : 'Every photo has already been read.');
    await load();
  }

  async function stopReading() {
    const res = await fetch('/api/photo-ocr/run', { method: 'DELETE' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { setNotice(body.error ?? `HTTP ${res.status}`); return; }
    setNotice(body.stopped ? `Stopped. ${body.stopped} photo${body.stopped === 1 ? '' : 's'} taken off the queue; the one being read now will finish. Read new photos picks them up again.` : 'Nothing was waiting; the photo being read now will finish.');
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
        const b = await res.json().catch(() => null) as { error?: string } | null;
        setError(b?.error === 'Order is locked' ? 'That order is locked. Unlock it on the order page first.' : (b?.error ?? `HTTP ${res.status}`));
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
              {quickQueue.length > 0 && (
                <button onClick={() => { setQuick(true); setQuickSkipped([]); setQuickStats({ accepted: 0, rejected: 0 }); setActive(null); }} className="px-3 py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 text-white">
                  Quick review {quickQueue.length}
                </button>
              )}
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
              {scanning > 0 && (
                <span className="text-xs text-gray-500">
                  {ocrQueue?.current
                    ? `Reading 1 photo (${ocrQueue.current.seconds}s so far), ${scanning - 1} after it`
                    : ocrQueue && ocrQueue.waiting === 0
                      ? `${scanning} waiting, but the reader is idle. Press Read new photos to restart them`
                      : `Reading ${scanning}…`}
                </span>
              )}
              {scanning > 1 && (
                <button onClick={stopReading} className="px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700 hover:border-red-500 text-gray-200">Stop reading</button>
              )}
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
          {manualCount > 0 && (
            <label className="flex items-center gap-1.5 text-xs text-gray-400">
              <input type="checkbox" checked={manualOnly} onChange={e => setManualOnly(e.target.checked)} />
              Only show photos set aside to sort by hand ({manualCount})
            </label>
          )}
          {quick && (() => {
            const p = quickCurrent;
            const o = p?.photoOcr;
            const ev = o?.evidence;
            const ord = ev?.order;
            const dr = !ord ? o?.draft ?? null : null;
            const snips = ord ? ev?.snips ?? [] : o?.draftSnips ?? [];
            const done = quickStats.accepted + quickStats.rejected;
            const tally = `${quickStats.accepted} attached, ${quickStats.rejected} set aside`;
            return (
              <div className="rounded-lg border border-emerald-800 bg-gray-900 p-4 space-y-4">
                <div className="flex items-center justify-between text-xs text-gray-400">
                  <span>{p ? `${quickQueue.filter(x => !quickSkipped.includes(x.id)).length} to check` : 'Done'}{done ? `, ${tally}` : ''}</span>
                  <button onClick={() => setQuick(false)} className="hover:text-white">Close (Esc)</button>
                </div>
                {!p || !o || (!ord && !dr) ? (
                  <p className="text-sm text-gray-300 py-6 text-center">
                    Nothing left to check.{quickSkipped.length ? ` ${quickSkipped.length} skipped.` : ''}{manualCount ? ` ${manualCount} set aside to sort by hand below.` : ''}
                  </p>
                ) : (
                  <>
                    <div className="flex flex-col items-center gap-2 bg-black/40 rounded p-3 min-h-[120px] justify-center">
                      {quickWhole ? (
                        <img src={`/api/orders/attachments/unassigned/${p.id}`} alt={p.originalName}
                          style={{ transform: `rotate(${p.rotation}deg)` }} className="max-h-[60vh] max-w-full object-contain rounded" />
                      ) : snips.length > 0 ? snips.map((b, i) => (
                        <img key={i} src={`/api/orders/attachments/unassigned/${p.id}?snip=${b.join(',')}&r=${p.rotation}`} alt="Where the match was read" className="max-h-40 max-w-full rounded" />
                      )) : (
                        <>
                          <img src={`/api/orders/attachments/unassigned/${p.id}?thumb=1&r=${p.rotation}`} alt={p.originalName} className="max-h-72 rounded" />
                          <span className="text-[11px] text-gray-500">No crop for this {dr ? 'reading' : 'match'}, so the whole photo is shown{ev?.matchedLines[0] ? `. Read: ${ev.matchedLines[0]}` : ''}</span>
                        </>
                      )}
                      <button onClick={() => setQuickWhole(w => !w)} className="text-[11px] text-blue-400 hover:text-blue-300">
                        {quickWhole ? 'Show just the matched part (F)' : 'Show the whole photo (F)'}
                      </button>
                    </div>
                    {dr ? (
                    <p className="text-sm text-gray-100 text-center leading-relaxed">
                      <span className="text-sky-300">New order</span>{' '}
                      {dr.platform}, {formatOrderDate(dr.orderDate, { dateOnly: true })}, ${Number(dr.cost).toFixed(2)}
                      {dr.orderNumber ? <>, <span className="font-mono">#{dr.orderNumber}</span></> : ''}
                      {dr.itemDescription ? `, ${dr.itemDescription}` : ''}
                    </p>
                    ) : ev && ord && (
                    <p className="text-sm text-gray-100 text-center leading-relaxed">
                      <span className={o.strength === 'exact' ? 'text-green-400' : 'text-amber-300'}>{o.strength === 'exact' ? 'Matches' : 'Probably'}</span>{' '}
                      {ev.cardNumber && <>gift card <span className="font-mono text-green-300">{ev.cardNumber}</span> on </>}
                      order <span className={`font-mono ${ev.orderNumber ? 'text-green-300' : ''}`}>{ord.orderNumber ? `#${ord.orderNumber}` : `(no number, id ${ord.id})`}</span>
                      {', '}{ord.platform}, {formatOrderDate(ord.orderDate)}, ${ord.cost.toFixed(2)}{ord.group ? `, ${ord.group}` : ''}
                    </p>
                    )}
                    <div className="flex justify-center gap-2">
                      <button disabled={quickBusy} onClick={() => quickDecide(true)} className="px-5 py-2 rounded bg-green-700 hover:bg-green-600 text-white text-sm disabled:opacity-50">{dr ? 'Create (A)' : 'Accept (A)'}</button>
                      <button disabled={quickBusy} onClick={() => quickDecide(false)} className="px-5 py-2 rounded bg-gray-800 border border-gray-700 hover:border-red-500 text-gray-200 text-sm disabled:opacity-50">Reject (R)</button>
                      <button disabled={quickBusy} onClick={() => setQuickSkipped(s => [...s, p.id])} className="px-3 py-2 rounded text-gray-500 hover:text-gray-300 text-sm">Skip (S)</button>
                    </div>
                    <p className="text-[11px] text-gray-500 text-center">{dr ? 'Accept creates this order and attaches the photo. ' : ''}Rejected photos are set aside to sort by hand and aren&apos;t guessed again.</p>
                    {error && <p className="text-xs text-red-400 text-center">{error}</p>}
                  </>
                )}
              </div>
            );
          })()}
          {!quick && <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
            {photos.filter(p => (!phoneOnly || p.uploadToken) && (!manualOnly || p.photoOcr?.manual)).map(p => {
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
                  {p.photoOcr?.manual && (
                    <span title="Rejected in quick review" className="absolute top-1 right-1 px-1.5 rounded text-[10px] bg-amber-700/90 text-amber-50">By hand</span>
                  )}
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
                  {p.photoOcr?.status === 'stopped' && (
                    <span title="Reading was stopped. Read new photos reads it." className="absolute bottom-1 left-1 px-1.5 rounded text-[10px] bg-black/70 text-gray-400">Not read</span>
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
          </div>}
        </>
      )}

      {active && !quick && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => { setActive(null); setZoomed(false); }}>
          <div className="bg-gray-900 border border-gray-700 rounded-lg max-w-7xl w-full max-h-[94vh] flex flex-col md:flex-row overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="md:w-1/2 shrink-0 bg-black/40 border-b md:border-b-0 md:border-r border-gray-700 relative flex items-center justify-center h-[45vh] md:h-auto">
              {IMAGE_TYPES.includes(active.mimeType) ? (
                <>
                  <button onClick={() => setZoomed(true)} title="Open larger" className="w-full h-full cursor-zoom-in flex items-center justify-center p-2">
                    <img
                      src={`/api/orders/attachments/unassigned/${active.id}`}
                      alt={active.originalName}
                      style={{ transform: `rotate(${active.rotation}deg)` }}
                      className="max-w-full max-h-full md:max-h-[90vh] object-contain"
                    />
                  </button>
                  <button onClick={rotate} title="Rotate 90°"
                    className="absolute top-2 right-2 bg-black/60 hover:bg-black/80 text-white rounded-full w-8 h-8 flex items-center justify-center text-lg">⟳</button>
                </>
              ) : (
                <div className="text-4xl">📎</div>
              )}
            </div>
            <div className="flex-1 min-w-0 overflow-y-auto p-5 space-y-4">
            <div className="flex items-start gap-4">
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
              if (o.status === 'stopped') return <p className="text-xs text-gray-500">Not read yet: reading was stopped. Read new photos reads it.</p>;
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
                  {o.evidence && ((o.evidence.snips?.length ?? 0) > 0 || o.evidence.order) && (
                    <div className="text-xs rounded bg-gray-800/60 border border-gray-700 p-2 grid gap-2 sm:grid-cols-2">
                      <div className="space-y-1 min-w-0">
                        <p className="text-gray-500">On the photo</p>
                        {(o.evidence.snips ?? []).map((b, i) => (
                          <img key={i} src={`/api/orders/attachments/unassigned/${active.id}?snip=${b.join(',')}&r=${active.rotation}`}
                            alt={o.evidence!.matchedLines[i] ?? 'matched text'}
                            className="w-full rounded border border-green-800 bg-black/30" />
                        ))}
                        {(o.evidence.snips?.length ?? 0) === 0 && <p className="text-gray-500">{o.evidence.matchedLines.length ? 'No position saved for this read; re-read the photo to get a crop.' : 'No single line matched; see the reason above.'}</p>}
                      </div>
                      {o.evidence.order && (() => {
                        const eo = o.evidence.order;
                        const hit = (v: string | null | undefined) => !!v && o.evidence!.matchedLines.some(l => l.toUpperCase().replace(/[^A-Z0-9]/g, '').includes(v.toUpperCase().replace(/[^A-Z0-9]/g, '')));
                        return (
                          <dl className="space-y-0.5 min-w-0">
                            <p className="text-gray-500">The order it matched</p>
                            <div className="flex gap-2"><dt className="text-gray-500 w-20 shrink-0">Order #</dt><dd className={`font-mono truncate ${hit(eo.orderNumber) ? 'text-green-300' : 'text-gray-100'}`}>{eo.orderNumber || '—'}</dd></div>
                            <div className="flex gap-2"><dt className="text-gray-500 w-20 shrink-0">Store</dt><dd className="text-gray-100 truncate">{eo.platform}</dd></div>
                            <div className="flex gap-2"><dt className="text-gray-500 w-20 shrink-0">Date</dt><dd className="text-gray-100">{formatOrderDate(eo.orderDate, { dateOnly: true })}</dd></div>
                            <div className="flex gap-2"><dt className="text-gray-500 w-20 shrink-0">Cost</dt><dd className="text-gray-100">${eo.cost.toFixed(2)}</dd></div>
                            {eo.itemDescription && <div className="flex gap-2"><dt className="text-gray-500 w-20 shrink-0">Item</dt><dd className="text-gray-100 truncate">{eo.itemDescription}</dd></div>}
                            {eo.group && <div className="flex gap-2"><dt className="text-gray-500 w-20 shrink-0">Group</dt><dd className="text-gray-100 truncate">{eo.group}</dd></div>}
                            {eo.paidWith && <div className="flex gap-2"><dt className="text-gray-500 w-20 shrink-0">Paid with</dt><dd className="text-gray-100 truncate">{eo.paidWith}</dd></div>}
                            {eo.giftCards.length > 0 && (
                              <div className="flex gap-2"><dt className="text-gray-500 w-20 shrink-0">Gift cards</dt>
                                <dd className="space-y-0.5 min-w-0">{eo.giftCards.map(g => (
                                  <div key={g.id} className={`font-mono truncate ${o.evidence!.cardNumber === g.cardNumber || hit(g.cardNumber) ? 'text-green-300' : 'text-gray-300'}`}>{g.cardNumber} <span className="font-sans text-gray-500">${g.value}</span></div>
                                ))}</dd>
                              </div>
                            )}
                            <a href={`/orders/${eo.id}`} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">Open order</a>
                          </dl>
                        );
                      })()}
                    </div>
                  )}
                  {o.evidence && (o.evidence.cardNumber || o.evidence.matchedLines.length > 0) && (
                    <div className="text-xs rounded bg-gray-800/60 border border-gray-700 px-2 py-1.5 space-y-0.5">
                      {o.evidence.cardNumber && <p className="text-gray-400">Gift card on the order: <span className="font-mono text-gray-100">{o.evidence.cardNumber}</span></p>}
                      {!o.evidence.cardNumber && o.evidence.orderNumber && <p className="text-gray-400">Order number: <span className="font-mono text-gray-100">{o.evidence.orderNumber}</span></p>}
                      {o.evidence.matchedLines.length > 0
                        ? <p className="text-gray-400">Read off the photo as: {o.evidence.matchedLines.map((l, i) => <span key={i} className="font-mono text-green-300 mr-2">{l}</span>)}</p>
                        : <p className="text-gray-500">Matched on a number rebuilt from the receipt's summary line.</p>}
                    </div>
                  )}
                  {o.evidence?.locked && <p className="text-xs text-amber-400">This order is locked. The photo can be attached; unlock it to apply gift codes.</p>}
                  {(o.lines?.length ?? 0) > 0 && (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-gray-500 hover:text-gray-300">Everything OCR read ({o.lines!.length} lines)</summary>
                      <div className="mt-1 max-h-40 overflow-y-auto rounded bg-gray-950 border border-gray-800 p-2 font-mono text-gray-300 space-y-0.5">
                        {o.lines!.map((l, i) => <div key={i} className={o.evidence?.matchedLines.includes(l) ? 'text-green-300' : ''}>{l}</div>)}
                      </div>
                    </details>
                  )}
                  {o.suggestedOrderId != null && (
                    <div className="flex gap-2">
                      <button disabled={assigning} onClick={rejectSuggestion} className="flex-1 px-3 py-1.5 rounded border border-gray-700 bg-gray-800 hover:border-red-500 text-xs text-gray-300 disabled:opacity-50">Not this order</button>
                      {reviewing && <button onClick={() => openNextReview(active.id)} className="flex-1 px-3 py-1.5 rounded border border-gray-700 bg-gray-800 hover:border-gray-500 text-xs text-gray-400">Skip</button>}
                    </div>
                  )}
                  {draftForm && (() => {
                    const set = (patch: Partial<DraftForm>) => setDraftForm(f => f ? { ...f, ...patch } : f);
                    const field = 'bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-100';
                    return (
                      <div className="rounded border border-blue-800 bg-blue-950/30 p-2 space-y-1.5">
                        <p className="text-xs text-blue-200">New order filled in from this photo. Check each field against the photo before creating it.</p>
                        <div className="grid grid-cols-2 gap-1.5">
                          <input value={draftForm.platform} onChange={e => set({ platform: e.target.value })} placeholder="Store" aria-label="Store" className={field} />
                          <input type="date" value={draftForm.orderDate} onChange={e => set({ orderDate: e.target.value })} aria-label="Order date" className={field} />
                          <input value={draftForm.orderNumber} onChange={e => set({ orderNumber: e.target.value })} placeholder="Order number" aria-label="Order number" className={`${field} font-mono col-span-2`} />
                          <input value={draftForm.cost} onChange={e => set({ cost: e.target.value })} placeholder="Cost before tax" inputMode="decimal" aria-label="Cost" className={field} />
                          <select value={draftForm.cardId} onChange={e => set({ cardId: e.target.value })} aria-label="Card" className={field}>
                            <option value="">No card</option>
                            {cards.map(c => <option key={c.id} value={c.id}>{c.name}{c.last4 ? ` (${c.last4})` : ''}</option>)}
                          </select>
                          <select value={draftForm.buyerId} onChange={e => set({ buyerId: e.target.value })} aria-label="Group" className={`${field} col-span-2`}>
                            <option value="">No group</option>
                            {buyers.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                          </select>
                          <input value={draftForm.itemDescription} onChange={e => set({ itemDescription: e.target.value })} placeholder="Items" aria-label="Items" className={`${field} col-span-2`} />
                        </div>
                        <div className="flex gap-2">
                          <button disabled={assigning} onClick={createFromDraft} className="flex-1 px-3 py-1.5 rounded bg-blue-700 hover:bg-blue-600 text-xs text-white disabled:opacity-50">
                            Create order and attach{codeRows.some(r => r.include) ? ` with ${codeRows.filter(r => r.include).length} gift code${codeRows.filter(r => r.include).length === 1 ? '' : 's'}` : ''}
                          </button>
                          <button disabled={assigning} onClick={rejectSuggestion} className="px-3 py-1.5 rounded border border-gray-700 bg-gray-800 hover:border-red-500 text-xs text-gray-300 disabled:opacity-50">Reject</button>
                          {reviewing && <button onClick={() => openNextReview(active.id)} className="px-3 py-1.5 rounded border border-gray-700 bg-gray-800 hover:border-gray-500 text-xs text-gray-400">Skip</button>}
                        </div>
                      </div>
                    );
                  })()}
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
                  {o.strength !== 'exact' && !draftForm && (
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

            {active && (
              <p className="text-xs text-gray-400">
                Not in the list?{' '}
                <Link href={`/orders/new?photo=${active.id}`} className="text-blue-400 hover:text-blue-300 underline">New order from this photo</Link>
                {' '}fills in what the photo shows and attaches it when you save.
              </p>
            )}

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
