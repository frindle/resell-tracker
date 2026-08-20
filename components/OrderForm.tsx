'use client';

import { forwardRef, useEffect, useImperativeHandle, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { computeCashback } from '@/lib/cashback';

export type OrderFormHandle = {
  submit(opts?: { lockAfterSave?: boolean }): void;
  isSaving(): boolean;
};

function trackingUrl(t: string): string {
  if (/^TBA\d+/i.test(t)) return `https://track.amazon.com/tracking/${t}`;
  if (/^1Z[A-Z0-9]{16}$/i.test(t)) return `https://www.ups.com/track?tracknum=${t}`;
  if (/^9\d{19,21}$/.test(t)) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${t}`;
  if (/^[1-8]\d{14}$/.test(t)) return `https://www.fedex.com/fedextrack/?trknbr=${t}`;
  return `https://www.google.com/search?q=${encodeURIComponent(t + ' tracking')}`;
}

type Buyer = { id: number; name: string };
type MerchantRate = { merchant: string; pointsPerDollar: number };
type Card = { id: number; name: string; rewardsRate: number | null; excludeShippingFromCashback: boolean; basePointsPerDollar: number | null; merchantRates: MerchantRate[] };

type OrderFormProps = {
  returnTo?: string;
  // Extra buttons rendered inline with Save Changes / Save and Lock (top row).
  // Currently: Lock Order + View on <merchant> from the parent page. Kept as
  // a slot so the form component doesn't need to know about merchant URLs.
  topExtras?: React.ReactNode;
  initialData?: {
    id: number;
    platform: string;
    orderNumber: string | null;
    groupReferenceId: string | null;
    orderDate: string;
    itemDescription: string | null;
    cost: number;
    shippingCost: number;
    insuranceCost: number;
    returnedCost?: number;
    salePrice: number | null;
    salePriceSynced: boolean;
    buyerId: number | null;
    cardId: number | null;
    cashbackAmount: number;
    portalCashback: number | null;
    shippingAddress: string | null;
    trackingNumbers: string | null;
    trackingValues: string | null;
    delayedShipping: boolean;
    noRushBonusPercent: number | null;
    notes: string | null;
    overdueAt: string | null;
    deliveryDeadline: string | null;
    lost: boolean;
    locked: boolean;
    updatedAt?: string | Date;
  };
};

const DEFAULT_PLATFORMS = ['Amazon', 'Walmart', 'Costco'];

function toDateTimeInput(iso: string) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseAmt(v: string): number {
  return parseFloat(v.replace(/,/g, '')) || 0;
}

const OrderForm = forwardRef<OrderFormHandle, OrderFormProps>(function OrderForm({ initialData, returnTo, topExtras }, ref) {
  const router = useRouter();
  const [buyers, setBuyers] = useState<Buyer[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [platforms, setPlatforms] = useState<string[]>(DEFAULT_PLATFORMS);
  const [newBuyer, setNewBuyer] = useState('');
  const [newCard, setNewCard] = useState('');
  const [saving, setSaving] = useState(false);
  type PendingCard = { merchant: string; value: string; cardNumber: string; pin: string };
  const [pendingCards, setPendingCards] = useState<PendingCard[]>([]);
  const [gcForm, setGcForm] = useState<PendingCard>({ merchant: '', value: '', cardNumber: '', pin: '' });
  const [addingGc, setAddingGc] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [isPaid, setIsPaid] = useState(initialData?.salePriceSynced ?? false);
  const [isLost, setIsLost] = useState(initialData?.lost ?? false);
  const [markingPaid, setMarkingPaid] = useState(false);
  const [markingLost, setMarkingLost] = useState(false);
  const [trackingValues, setTrackingValues] = useState<Record<string, string>>(() => {
    try { return JSON.parse(initialData?.trackingValues ?? '{}'); } catch { return {}; }
  });
  const [paidError, setPaidError] = useState('');
  const [customPlatform, setCustomPlatform] = useState(
    initialData ? !DEFAULT_PLATFORMS.includes(initialData.platform) : false
  );
  const [customPlatformInput, setCustomPlatformInput] = useState(
    initialData && !DEFAULT_PLATFORMS.includes(initialData.platform) ? initialData.platform : ''
  );

  const [form, setForm] = useState({
    platform: initialData?.platform ?? 'Amazon',
    orderNumber: initialData?.orderNumber ?? '',
    groupReferenceId: initialData?.groupReferenceId ?? '',
    orderDate: initialData ? toDateTimeInput(initialData.orderDate) : toDateTimeInput(new Date().toISOString()),
    itemDescription: initialData?.itemDescription ?? '',
    cost: initialData?.cost?.toString() ?? '',
    shippingCost: initialData?.shippingCost?.toString() ?? '0',
    insuranceCost: initialData?.insuranceCost?.toString() ?? '0',
    salePrice: initialData?.salePrice?.toString() ?? '',
    buyerId: initialData?.buyerId?.toString() ?? '',
    cardId: initialData?.cardId?.toString() ?? '',
    cashbackAmount: initialData?.cashbackAmount?.toString() ?? '0',
    portalCashback: initialData?.portalCashback?.toString() ?? '',
    shippingAddress: initialData?.shippingAddress ?? '',
    trackingNumbers: initialData?.trackingNumbers ?? '',
    notes: initialData?.notes ?? '',
    overdueAt: initialData?.overdueAt ? toDateTimeInput(initialData.overdueAt) : '',
    deliveryDeadline: initialData?.deliveryDeadline ? toDateTimeInput(initialData.deliveryDeadline).slice(0, 10) : '',
  });
  const [cashbackSaveError, setCashbackSaveError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/buyers').then(r => r.json()).then(setBuyers);
    fetch('/api/cards').then(r => r.json()).then(setCards);
    fetch('/api/orders/platforms').then(r => r.json()).then((saved: string[]) => {
      setPlatforms(prev => {
        const all = [...prev];
        for (const p of saved) if (!all.includes(p)) all.push(p);
        return all;
      });
    }).catch(() => {});
  }, []);

  useEffect(() => {
    function onSalePriceUpdated(e: Event) {
      const price = (e as CustomEvent<number>).detail;
      setForm(prev => ({ ...prev, salePrice: String(price) }));
    }
    window.addEventListener('sale-price-updated', onSalePriceUpdated);
    return () => window.removeEventListener('sale-price-updated', onSalePriceUpdated);
  }, []);

  const set = useCallback((field: string, value: string) => {
    setForm(prev => ({ ...prev, [field]: value }));
  }, []);

  // Auto-calculate cashback when card or cost changes, and persist if it
  // differs from the stored value so the orders list page stays in sync.
  useEffect(() => {
    if (!form.cardId) { set('cashbackAmount', '0'); return; }
    const card = cards.find(c => c.id === parseInt(form.cardId));
    if (!card || card.rewardsRate == null) { set('cashbackAmount', '0'); return; }
    // Net out returnedCost before computing cashback -- the card issuer
    // reverses cashback on the returned portion too, so cashback earned
    // should track the net (kept) cost, not the gross purchase price.
    // returnedCost isn't editable here (see the P&L preview below), same
    // reasoning applies: it comes off cost, not shipping/insurance, since
    // it's a cost-basis figure (see lib/orderReturns.ts returnedCostFor).
    const returnedCost = initialData?.returnedCost ?? 0;
    const cost = parseAmt(form.cost) - returnedCost;
    const shipping = parseAmt(form.shippingCost);
    const insurance = parseAmt(form.insuranceCost);
    const bonusPercent = initialData?.delayedShipping ? (initialData?.noRushBonusPercent ?? 0) : 0;
    const cb = computeCashback(cost, shipping, insurance, card.rewardsRate, card.excludeShippingFromCashback, bonusPercent);
    const cbStr = cb.toFixed(2);
    set('cashbackAmount', cbStr);
    if (initialData && Math.abs(cb - (initialData.cashbackAmount ?? 0)) > 0.01) {
      setCashbackSaveError(null);
      fetch(`/api/orders/${initialData.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cashbackAmount: cb }),
      }).then(res => {
        if (!res.ok) throw new Error(`save failed: ${res.status}`);
      }).catch(e => {
        console.error('[OrderForm] cashback auto-save failed:', e);
        setCashbackSaveError('Failed to save cashback — will retry on next edit or save.');
      });
    }
  }, [form.cardId, form.cost, form.shippingCost, form.insuranceCost, cards, set]);

  async function addCard() {
    if (!newCard.trim()) return;
    const res = await fetch('/api/cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newCard.trim() }),
    });
    const card = await res.json();
    setCards(prev => [...prev, card].sort((a, b) => a.name.localeCompare(b.name)));
    set('cardId', String(card.id));
    setNewCard('');
  }

  async function addBuyer() {
    if (!newBuyer.trim()) return;
    const res = await fetch('/api/buyers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newBuyer.trim() }),
    });
    const buyer = await res.json();
    setBuyers(prev => [...prev, buyer].sort((a, b) => a.name.localeCompare(b.name)));
    set('buyerId', String(buyer.id));
    setNewBuyer('');
  }

  async function handleSubmit(e: React.FormEvent, opts?: { lockAfterSave?: boolean }) {
    e.preventDefault();
    setSaving(true);
    try {
      const method = initialData ? 'PUT' : 'POST';
      const url = initialData ? `/api/orders/${initialData.id}` : '/api/orders';
      // Convert datetime-local strings ("YYYY-MM-DDTHH:mm", no offset) into
      // ISO strings that carry the user's real time. new Date(local) treats
      // the string as local time; toISOString() then serializes as UTC. If
      // we sent the raw string, a server parsing it as UTC would shift the
      // recorded time by the user's TZ offset — Costco order made at 10:30
      // AM PDT was landing as 03:30 AM (10:30 parsed as UTC).
      const localToIso = (v: string): string => {
        if (!v) return v;
        const d = new Date(v);
        return isNaN(d.getTime()) ? v : d.toISOString();
      };
      const payload: Record<string, unknown> = {
        ...form,
        orderDate: localToIso(form.orderDate),
        trackingValues: JSON.stringify(trackingValues),
      };
      // Optimistic lock — attach the updatedAt the client loaded so the
      // server can 409 if someone else has modified the row since.
      if (initialData?.updatedAt) {
        payload.__ifUnmodifiedSince = typeof initialData.updatedAt === 'string'
          ? initialData.updatedAt
          : new Date(initialData.updatedAt).toISOString();
      }
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.status === 409) {
        alert('This order was modified by another session. Reload to see the latest and try again.');
        return;
      }
      if (!res.ok) return;
      if (!initialData) {
        const created = await res.json();
        if (pendingCards.length > 0) {
          await Promise.all(pendingCards.map(c =>
            fetch(`/api/orders/${created.id}/gift-cards`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ merchant: c.merchant, value: parseFloat(c.value), cardNumber: c.cardNumber, pin: c.pin || null }),
            })
          ));
        }
        if (opts?.lockAfterSave) {
          await fetch(`/api/orders/${created.id}/lock`, { method: 'POST' });
        }
        router.push(`/orders/${created.id}`);
      } else {
        if (opts?.lockAfterSave) {
          await fetch(`/api/orders/${initialData.id}/lock`, { method: 'POST' });
        }
        // Stay on the order detail page after Save so the user can keep
        // editing or lock without bouncing back to /orders.
      }
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  async function markPaid() {
    setMarkingPaid(true);
    setPaidError('');
    try {
      const res = await fetch(`/api/orders/${initialData!.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ salePriceSynced: true }),
      });
      if (!res.ok) {
        const msg = await res.text();
        setPaidError(`Failed: ${msg || res.status}`);
      } else {
        setIsPaid(true);
      }
    } catch (e) {
      setPaidError(String(e));
    } finally {
      setMarkingPaid(false);
    }
  }

  async function markLost() {
    if (!confirm('Mark this order as lost? Sale price will be set to $0.')) return;
    setMarkingLost(true);
    try {
      const res = await fetch(`/api/orders/${initialData!.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lost: true, salePrice: 0 }),
      });
      if (res.ok) setIsLost(true);
    } finally {
      setMarkingLost(false);
    }
  }

  async function handleDelete() {
    if (!confirm('Delete this order?')) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/orders/${initialData!.id}`, { method: 'DELETE' });
      if (res.ok) {
        router.push(returnTo ?? '/orders');
        router.refresh();
      }
    } finally {
      setDeleting(false);
    }
  }

  // returnedCost isn't editable here — it's derived from the order's return
  // records — but it has to come off the cost side or this preview disagrees
  // with the P&L on the orders list for any order with a partial return.
  const returnedCost = initialData?.returnedCost ?? 0;
  const effCost = parseAmt(form.cost) + parseAmt(form.shippingCost) + parseAmt(form.insuranceCost) - returnedCost - parseAmt(form.cashbackAmount) - parseAmt(form.portalCashback);
  const pl = parseAmt(form.salePrice) - effCost;
  const fmt = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

  // Expose submit + saving state to the parent so the order-detail page can
  // render the Save Changes / Save and Lock buttons in its header row next
  // to Lock Order and View on <merchant>, instead of inside the form.
  // No dependency array: handleSubmit is redefined fresh every render and
  // closes over the current `form`. Memoizing this on [saving] alone (the
  // previous version) meant selecting a field (e.g. a card) re-rendered
  // without changing `saving`, so the exposed submit() kept calling a
  // stale handleSubmit closure from before that selection — Save would
  // silently send the pre-selection form state. Confirmed live 2026-07-30:
  // picking a card then immediately clicking Save sent cardId: "".
  useImperativeHandle(ref, () => ({
    submit(opts) {
      handleSubmit(
        { preventDefault: () => {} } as React.FormEvent,
        opts,
      );
    },
    isSaving() { return saving; },
  }));

  return (
    <form onSubmit={handleSubmit} className="space-y-6 max-w-2xl">
      {/* Top-of-form button row removed 2026-07-02 — the parent page
          renders Save Changes / Save and Lock / Lock Order / View next
          to the "Edit Order" heading via the OrderFormHandle ref. */}
      {initialData && topExtras && (
        <div className="flex justify-end gap-2 flex-wrap">
          {topExtras}
        </div>
      )}
      {/* Platform + Order # */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="label">Platform</label>
          {customPlatform ? (
            <div className="flex gap-2 items-center">
              <input
                type="text"
                value={customPlatformInput}
                onChange={e => { setCustomPlatformInput(e.target.value); set('platform', e.target.value); }}
                className="input flex-1"
                placeholder="Merchant name"
                autoFocus
              />
              <button
                type="button"
                onClick={() => { setCustomPlatform(false); set('platform', platforms.includes(customPlatformInput) ? customPlatformInput : platforms[0]); setCustomPlatformInput(''); }}
                className="text-xs text-gray-500 hover:text-white whitespace-nowrap"
              >
                Use preset
              </button>
            </div>
          ) : (
            <div className="flex gap-2 items-center">
              <select value={form.platform} onChange={e => set('platform', e.target.value)} className="input flex-1">
                {platforms.map(p => <option key={p}>{p}</option>)}
              </select>
              <button
                type="button"
                onClick={() => { setCustomPlatform(true); setCustomPlatformInput(''); set('platform', ''); }}
                className="text-xs text-gray-500 hover:text-white whitespace-nowrap"
              >
                Add new
              </button>
            </div>
          )}
        </div>
        <div>
          <label className="label">Order # <span className="text-gray-500">(optional)</span></label>
          <input type="text" value={form.orderNumber} onChange={e => set('orderNumber', e.target.value)} className="input" placeholder="123-4567890-1234567" />
        </div>
        <div>
          <label className="label">Group Reference Number <span className="text-gray-500">(optional override)</span></label>
          <input type="text" value={form.groupReferenceId} onChange={e => set('groupReferenceId', e.target.value)} className="input" placeholder="e.g. 265959442" />
        </div>
      </div>

      {/* Date + Description */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="label">Order Date</label>
          <input type="datetime-local" value={form.orderDate} onChange={e => set('orderDate', e.target.value)} className="input" required />
        </div>
        <div>
          <label className="label">Item Description <span className="text-gray-500">(optional)</span></label>
          <input type="text" value={form.itemDescription} onChange={e => set('itemDescription', e.target.value)} className="input" placeholder="What did you buy?" />
        </div>
      </div>

      {/* Cost + Shipping + Insurance */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <label className="label">Purchase Price</label>
          <input type="text" inputMode="decimal" value={form.cost} onChange={e => set('cost', e.target.value.replace(/[^0-9.,]/g, ''))} className="input" placeholder="0.00" required />
          {returnedCost > 0 && (
            <div className="text-xs text-gray-500 mt-1">
              Effective: <span className="text-gray-300">{fmt(parseAmt(form.cost) - returnedCost)}</span> ({fmt(returnedCost)} returned)
            </div>
          )}
        </div>
        <div>
          <label className="label">Shipping Fee</label>
          <input type="text" inputMode="decimal" value={form.shippingCost} onChange={e => set('shippingCost', e.target.value.replace(/[^0-9.,]/g, ''))} className="input" placeholder="0.00" />
        </div>
        <div>
          <label className="label">Insurance</label>
          <input type="text" inputMode="decimal" value={form.insuranceCost} onChange={e => set('insuranceCost', e.target.value.replace(/[^0-9.,]/g, ''))} className="input" placeholder="0.00" />
        </div>
      </div>

      {/* Sale Price + Buyer */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="label">Sale Price</label>
          <input type="text" inputMode="decimal" value={form.salePrice} onChange={e => set('salePrice', e.target.value.replace(/[^0-9.,]/g, ''))} className="input" placeholder="0.00" />
        </div>
        <div>
          <label className="label">Buyer</label>
          <div className="flex gap-2">
            <select value={form.buyerId} onChange={e => set('buyerId', e.target.value)} className="input flex-1">
              <option value="">— select —</option>
              {buyers.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <div className="flex gap-2 mt-1.5">
            <input
              type="text"
              value={newBuyer}
              onChange={e => setNewBuyer(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addBuyer())}
              className="input flex-1 text-xs py-1"
              placeholder="New buyer name…"
            />
            <button type="button" onClick={addBuyer} className="text-xs bg-gray-700 hover:bg-gray-600 px-2 rounded transition-colors">Add</button>
          </div>
        </div>
      </div>

      {/* Gift Cards — shown inline when CardCenter buyer is selected (new orders) */}
      {(() => {
        const selectedBuyer = buyers.find(b => b.id === parseInt(form.buyerId));
        if (!selectedBuyer || !/cardcenter/i.test(selectedBuyer.name)) return null;
        // On edit page, GiftCards component handles this — only show here for new orders
        if (initialData) return null;
        return (
          <div className="border border-gray-700 rounded-lg p-4 space-y-3">
            <h3 className="text-sm font-medium text-gray-300">Gift Cards</h3>
            {pendingCards.length > 0 && (
              <div className="rounded border border-gray-800 overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-gray-900 text-gray-500 uppercase">
                    <tr>
                      <th className="px-3 py-1.5 text-left">Merchant</th>
                      <th className="px-3 py-1.5 text-right">Value</th>
                      <th className="px-3 py-1.5 text-left">Card Number</th>
                      <th className="px-3 py-1.5 text-left">PIN</th>
                      <th className="px-3 py-1.5 w-6"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    {pendingCards.map((c, i) => (
                      <tr key={i}>
                        <td className="px-3 py-1.5 text-gray-300">{c.merchant}</td>
                        <td className="px-3 py-1.5 text-right text-green-400">${parseFloat(c.value).toFixed(2)}</td>
                        <td className="px-3 py-1.5 font-mono text-gray-300">{c.cardNumber}</td>
                        <td className="px-3 py-1.5 font-mono text-gray-400">{c.pin || '—'}</td>
                        <td className="px-3 py-1.5 text-right">
                          <button type="button" onClick={() => setPendingCards(prev => prev.filter((_, j) => j !== i))} className="text-gray-600 hover:text-red-400 transition-colors">×</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {addingGc ? (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <input placeholder="Merchant" value={gcForm.merchant} onChange={e => setGcForm(f => ({ ...f, merchant: e.target.value }))} className="input text-xs py-1" />
                  <input placeholder="Value" type="number" step="0.01" value={gcForm.value} onChange={e => setGcForm(f => ({ ...f, value: e.target.value }))} className="input text-xs py-1" />
                  <textarea
                    // See GiftCards.tsx comment: <textarea rows={1}> is the
                    // only reliable defeat for Firefox's card-autofill
                    // digit-replacement bug.
                    placeholder="Card Number"
                    value={gcForm.cardNumber}
                    onChange={e => setGcForm(f => ({ ...f, cardNumber: e.target.value.replace(/\r?\n/g, '') }))}
                    onKeyDown={e => { if (e.key === 'Enter') e.preventDefault(); }}
                    rows={1}
                    autoComplete="off"
                    name="giftCardCode"
                    spellCheck={false}
                    className="input text-xs py-1 font-mono resize-none leading-tight"
                  />
                  <input
                    placeholder="PIN (optional)"
                    value={gcForm.pin}
                    onChange={e => setGcForm(f => ({ ...f, pin: e.target.value }))}
                    // type=password + the readOnly-defocus trick reliably
                    // stops Firefox's card-autofill from intercepting each
                    // keystroke (the plain autoComplete=new-password fix
                    // wasn't enough for the PIN adjacent to a card number).
                    type="password"
                    autoComplete="new-password"
                    name="giftCardPin"
                    inputMode="text"
                    spellCheck={false}
                    readOnly
                    onFocus={e => e.currentTarget.removeAttribute('readonly')}
                    data-lpignore="true"
                    data-1p-ignore="true"
                    className="input text-xs py-1 font-mono"
                  />
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => { if (gcForm.merchant && gcForm.value && gcForm.cardNumber) { setPendingCards(p => [...p, gcForm]); setGcForm({ merchant: '', value: '', cardNumber: '', pin: '' }); setAddingGc(false); } }} className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded transition-colors">Add</button>
                  <button type="button" onClick={() => { setAddingGc(false); setGcForm({ merchant: '', value: '', cardNumber: '', pin: '' }); }} className="text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-400 px-3 py-1.5 rounded transition-colors">Cancel</button>
                </div>
              </div>
            ) : (
              <button type="button" onClick={() => setAddingGc(true)} className="text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-400 px-3 py-1.5 rounded-md transition-colors">+ Add Gift Card</button>
            )}
            {pendingCards.length > 0 && <p className="text-xs text-gray-600">Gift cards will be saved when you save the order.</p>}
          </div>
        );
      })()}

      {/* Card + Cashback */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="label">Credit Card</label>
          <select value={form.cardId} onChange={e => set('cardId', e.target.value)} className="input">
            <option value="">— no card —</option>
            {cards.map(c => (
              <option key={c.id} value={c.id}>
                {c.name}{c.rewardsRate != null ? ` (${c.rewardsRate}%)` : c.basePointsPerDollar != null ? ` (${c.basePointsPerDollar}×)` : ''}
              </option>
            ))}
          </select>
          {(() => {
            if (!form.cardId) return null;
            const card = cards.find(c => c.id === parseInt(form.cardId));
            if (!card || (card.merchantRates.length === 0 && card.basePointsPerDollar == null)) return null;
            const platform = customPlatform ? customPlatformInput : form.platform;
            const merchantRate = card.merchantRates.find(r => r.merchant.toLowerCase() === platform.toLowerCase());
            const ppd = merchantRate?.pointsPerDollar ?? card.basePointsPerDollar;
            if (!ppd) return null;
            const cost = parseAmt(form.cost);
            const miles = Math.round(cost * ppd);
            const label = merchantRate ? `${ppd}× (${merchantRate.merchant})` : `${ppd}× (base rate)`;
            return <p className="text-xs text-blue-400 mt-1">~{miles.toLocaleString()} pts at {label}</p>;
          })()}
          <div className="flex gap-2 mt-1.5">
            <input
              type="text"
              value={newCard}
              onChange={e => setNewCard(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addCard())}
              className="input flex-1 text-xs py-1"
              placeholder="New card name…"
            />
            <button type="button" onClick={addCard} className="text-xs bg-gray-700 hover:bg-gray-600 px-2 rounded transition-colors">Add</button>
          </div>
        </div>
        <div>
          <label className="label">Cashback Amount</label>
          <input type="text" inputMode="decimal" value={form.cashbackAmount} onChange={e => set('cashbackAmount', e.target.value.replace(/[^0-9.,]/g, ''))} className="input" placeholder="0.00" />
          <p className="text-xs text-gray-500 mt-1">Auto-filled from card rate, edit if needed</p>
          {cashbackSaveError && <p className="text-xs text-red-400 mt-1">{cashbackSaveError}</p>}
        </div>
        <div>
          <label className="label">Portal Cashback</label>
          <input type="text" inputMode="decimal" value={form.portalCashback} onChange={e => set('portalCashback', e.target.value.replace(/[^0-9.,]/g, ''))} className="input" placeholder="0.00" />
          <p className="text-xs text-gray-500 mt-1">Pending cashback from a portal (TopCashback, Rakuten, etc.)</p>
        </div>
      </div>

      {/* Shipping Address + Notes */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="label">Shipping Address <span className="text-gray-500">(optional)</span></label>
          <textarea value={form.shippingAddress} onChange={e => set('shippingAddress', e.target.value)} className="input resize-none h-20 text-sm" placeholder="Ship-to address…" />
          <div className="mt-2 space-y-1">
            <label className="text-xs text-gray-500">Tracking Numbers <span className="text-gray-600">(comma-separated)</span></label>
            <input
              type="text"
              value={form.trackingNumbers}
              onChange={e => set('trackingNumbers', e.target.value)}
              onBlur={e => window.dispatchEvent(new CustomEvent('tracking-numbers-updated', { detail: e.target.value }))}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault(); // don't submit the form
                  window.dispatchEvent(new CustomEvent('tracking-numbers-updated', { detail: e.currentTarget.value }));
                }
              }}
              className="input text-xs font-mono"
              placeholder="e.g. 1Z999AA10123456784, TBA123456789000"
            />
            {form.trackingNumbers && (() => {
              const trackingList = form.trackingNumbers.split(',').map(t => t.trim()).filter(Boolean);
              const isSplit = trackingList.length > 1;
              return (
                <div className="space-y-1 pt-0.5">
                  {trackingList.map(t => (
                    <div key={t} className="flex items-center gap-2">
                      <a href={trackingUrl(t)} target="_blank" rel="noopener noreferrer"
                        className="text-xs font-mono bg-gray-800 text-blue-400 hover:text-blue-300 px-2 py-1 rounded hover:bg-gray-700 transition-colors flex-1 truncate">
                        {t}
                      </a>
                      {isSplit && (
                        <input
                          // type=text + inputMode=decimal avoids the
                          // number-input scroll-into-view + arrow-key
                          // page-jump reported on this field. Same UX
                          // (numeric keyboard on mobile, no spinner on
                          // desktop) without the bugs.
                          type="text"
                          inputMode="decimal"
                          pattern="[0-9]*\.?[0-9]*"
                          placeholder="Value"
                          value={trackingValues[t] ?? ''}
                          onChange={e => setTrackingValues(prev => ({ ...prev, [t]: e.target.value }))}
                          onWheel={e => (e.currentTarget as HTMLInputElement).blur()}
                          className="w-24 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
                        />
                      )}
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
        </div>
        <div>
          <label className="label">Notes <span className="text-gray-500">(optional)</span></label>
          <textarea value={form.notes} onChange={e => set('notes', e.target.value)} className="input resize-none h-20" placeholder="Any additional notes…" />
        </div>
      </div>

      {/* Payment Due Date + Delivery Deadline */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="label">Payment Due Date <span className="text-gray-500">(optional)</span></label>
          <input
            type="date"
            value={form.overdueAt}
            onChange={e => set('overdueAt', e.target.value)}
            className="input"
          />
          <p className="text-xs text-gray-500 mt-1">Set to mark when payment is expected</p>
        </div>
        <div>
          <label className="label">Delivery Deadline <span className="text-gray-500">(optional)</span></label>
          <input
            type="date"
            value={form.deliveryDeadline}
            onChange={e => set('deliveryDeadline', e.target.value)}
            className="input"
          />
          <p className="text-xs text-gray-500 mt-1">Group's hard deadline; badge on order card when set (red within 3 days)</p>
        </div>
      </div>

      {/* P&L Preview */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 flex gap-6 text-sm">
        <div>
          <span className="text-gray-400">Eff. Cost</span>
          <span className="ml-2 font-medium">{fmt(effCost)}</span>
        </div>
        <div>
          <span className="text-gray-400">Sale</span>
          <span className="ml-2 font-medium">{fmt(parseAmt(form.salePrice))}</span>
        </div>
        <div>
          <span className="text-gray-400">P&L</span>
          <span className={`ml-2 font-bold ${pl >= 0 ? 'text-green-400' : 'text-red-400'}`}>{fmt(pl)}</span>
        </div>
      </div>

      <div className="flex gap-2 flex-wrap">
        {!initialData && (
          <>
            <button type="submit" disabled={saving} className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm px-3 py-1.5 rounded-md transition-colors border border-blue-700 whitespace-nowrap">
              {saving ? 'Saving…' : 'Add Order'}
            </button>
            <button type="button" onClick={() => router.back()} className="bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm px-3 py-1.5 rounded-md transition-colors border border-gray-700 whitespace-nowrap">
              Cancel
            </button>
          </>
        )}
        {initialData && !isPaid && (
          <button type="button" onClick={markPaid} disabled={markingPaid} className="bg-green-800 hover:bg-green-700 disabled:opacity-50 text-green-200 text-sm px-3 py-1.5 rounded-md transition-colors border border-green-900 whitespace-nowrap">
            {markingPaid ? 'Marking…' : 'Mark as Paid'}
          </button>
        )}
        {initialData && isPaid && (
          <span className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md bg-green-900/40 text-green-400">
            ✓ Paid
          </span>
        )}
        {paidError && (
          <span className="text-red-400 text-xs self-center">{paidError}</span>
        )}
        {initialData && !isLost && !isPaid && (
          <button type="button" onClick={markLost} disabled={markingLost} className="bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-400 text-sm px-3 py-1.5 rounded-md transition-colors border border-gray-700 whitespace-nowrap">
            {markingLost ? 'Marking…' : 'Mark as Lost'}
          </button>
        )}
        {initialData && isLost && (
          <span className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md bg-gray-800 text-gray-400">
            Lost
          </span>
        )}
        {initialData && (
          <button type="button" onClick={handleDelete} disabled={deleting} className="bg-red-900/50 hover:bg-red-900 text-red-400 text-sm px-3 py-1.5 rounded-md transition-colors border border-red-900 whitespace-nowrap">
            {deleting ? 'Deleting…' : 'Delete Order'}
          </button>
        )}
      </div>
    </form>
  );
});
export default OrderForm;
