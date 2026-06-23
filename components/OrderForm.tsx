'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';

function trackingUrl(t: string): string {
  if (/^TBA\d+/i.test(t)) return `https://track.amazon.com/tracking/${t}`;
  if (/^1Z[A-Z0-9]{16}$/i.test(t)) return `https://www.ups.com/track?tracknum=${t}`;
  if (/^9\d{19,21}$/.test(t)) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${t}`;
  if (/^[1-8]\d{14}$/.test(t)) return `https://www.fedex.com/fedextrack/?trknbr=${t}`;
  return `https://www.google.com/search?q=${encodeURIComponent(t + ' tracking')}`;
}

type Buyer = { id: number; name: string };
type MerchantRate = { merchant: string; pointsPerDollar: number };
type Card = { id: number; name: string; rewardsRate: number | null; basePointsPerDollar: number | null; merchantRates: MerchantRate[] };

type OrderFormProps = {
  returnTo?: string;
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
    salePrice: number | null;
    salePriceSynced: boolean;
    buyerId: number | null;
    cardId: number | null;
    cashbackAmount: number;
    shippingAddress: string | null;
    trackingNumbers: string | null;
    trackingValues: string | null;
    notes: string | null;
    overdueAt: string | null;
    lost: boolean;
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

export default function OrderForm({ initialData, returnTo }: OrderFormProps) {
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
    orderDate: initialData ? toDateTimeInput(initialData.orderDate) : new Date().toISOString().slice(0, 16),
    itemDescription: initialData?.itemDescription ?? '',
    cost: initialData?.cost?.toString() ?? '',
    shippingCost: initialData?.shippingCost?.toString() ?? '0',
    insuranceCost: initialData?.insuranceCost?.toString() ?? '0',
    salePrice: initialData?.salePrice?.toString() ?? '',
    buyerId: initialData?.buyerId?.toString() ?? '',
    cardId: initialData?.cardId?.toString() ?? '',
    cashbackAmount: initialData?.cashbackAmount?.toString() ?? '0',
    shippingAddress: initialData?.shippingAddress ?? '',
    trackingNumbers: initialData?.trackingNumbers ?? '',
    notes: initialData?.notes ?? '',
    overdueAt: initialData?.overdueAt ? toDateTimeInput(initialData.overdueAt) : '',
  });

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

  const set = useCallback((field: string, value: string) => {
    setForm(prev => ({ ...prev, [field]: value }));
  }, []);

  // Auto-calculate cashback when card or cost changes
  useEffect(() => {
    if (!form.cardId) { set('cashbackAmount', '0'); return; }
    const card = cards.find(c => c.id === parseInt(form.cardId));
    if (!card || card.rewardsRate == null) { set('cashbackAmount', '0'); return; }
    const cost = parseAmt(form.cost);
    const shipping = parseAmt(form.shippingCost);
    const insurance = parseAmt(form.insuranceCost);
    const cb = ((cost + shipping + insurance) * card.rewardsRate) / 100;
    set('cashbackAmount', cb.toFixed(2));
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const method = initialData ? 'PUT' : 'POST';
      const url = initialData ? `/api/orders/${initialData.id}` : '/api/orders';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, trackingValues: JSON.stringify(trackingValues) }),
      });
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
        router.push(`/orders/${created.id}`);
      } else {
        router.push(returnTo ?? '/orders');
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

  const effCost = parseAmt(form.cost) + parseAmt(form.shippingCost) + parseAmt(form.insuranceCost) - parseAmt(form.cashbackAmount);
  const pl = parseAmt(form.salePrice) - effCost;
  const fmt = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

  return (
    <form onSubmit={handleSubmit} className="space-y-6 max-w-2xl">
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
                  <input placeholder="Card Number" value={gcForm.cardNumber} onChange={e => setGcForm(f => ({ ...f, cardNumber: e.target.value }))} autoComplete="off" spellCheck={false} className="input text-xs py-1 font-mono" />
                  <input placeholder="PIN (optional)" value={gcForm.pin} onChange={e => setGcForm(f => ({ ...f, pin: e.target.value }))} autoComplete="off" spellCheck={false} className="input text-xs py-1 font-mono" />
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
                          type="number" step="0.01" placeholder="Value"
                          value={trackingValues[t] ?? ''}
                          onChange={e => setTrackingValues(prev => ({ ...prev, [t]: e.target.value }))}
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

      {/* Payment Due Date */}
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

      <div className="flex gap-3">
        <button type="submit" disabled={saving} className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-4 py-2 rounded-md text-sm transition-colors">
          {saving ? 'Saving…' : initialData ? 'Save Changes' : 'Add Order'}
        </button>
        <button type="button" onClick={() => router.back()} className="bg-gray-800 hover:bg-gray-700 text-gray-300 px-4 py-2 rounded-md text-sm transition-colors">
          Cancel
        </button>
        {initialData && !isPaid && (
          <button type="button" onClick={markPaid} disabled={markingPaid} className="bg-green-800 hover:bg-green-700 disabled:opacity-50 text-green-200 px-4 py-2 rounded-md text-sm transition-colors">
            {markingPaid ? 'Marking…' : 'Mark as Paid'}
          </button>
        )}
        {initialData && isPaid && (
          <span className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-sm bg-green-900/40 text-green-400">
            ✓ Paid
          </span>
        )}
        {paidError && (
          <span className="text-red-400 text-xs">{paidError}</span>
        )}
        {initialData && !isLost && !isPaid && (
          <button type="button" onClick={markLost} disabled={markingLost} className="bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-400 px-4 py-2 rounded-md text-sm transition-colors">
            {markingLost ? 'Marking…' : 'Mark as Lost'}
          </button>
        )}
        {initialData && isLost && (
          <span className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-sm bg-gray-800 text-gray-400">
            Lost
          </span>
        )}
        {initialData && (
          <button type="button" onClick={handleDelete} disabled={deleting} className="ml-auto bg-red-900/50 hover:bg-red-900 text-red-400 px-4 py-2 rounded-md text-sm transition-colors">
            {deleting ? 'Deleting…' : 'Delete Order'}
          </button>
        )}
      </div>
    </form>
  );
}
