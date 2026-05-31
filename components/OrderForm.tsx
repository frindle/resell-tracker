'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';

type Buyer = { id: number; name: string };
type MerchantRate = { merchant: string; pointsPerDollar: number };
type Card = { id: number; name: string; rewardsRate: number | null; basePointsPerDollar: number | null; merchantRates: MerchantRate[] };

type OrderFormProps = {
  returnTo?: string;
  initialData?: {
    id: number;
    platform: string;
    orderNumber: string | null;
    orderDate: string;
    itemDescription: string | null;
    cost: number;
    shippingCost: number;
    salePrice: number | null;
    buyerId: number | null;
    cardId: number | null;
    cashbackAmount: number;
    shippingAddress: string | null;
    trackingNumbers: string | null;
    notes: string | null;
  };
};

const DEFAULT_PLATFORMS = ['Amazon', 'Walmart', 'Costco'];

function toDateInput(iso: string) {
  return iso.split('T')[0];
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
  const [deleting, setDeleting] = useState(false);
  const [customPlatform, setCustomPlatform] = useState(
    initialData ? !DEFAULT_PLATFORMS.includes(initialData.platform) : false
  );
  const [customPlatformInput, setCustomPlatformInput] = useState(
    initialData && !DEFAULT_PLATFORMS.includes(initialData.platform) ? initialData.platform : ''
  );

  const [form, setForm] = useState({
    platform: initialData?.platform ?? 'Amazon',
    orderNumber: initialData?.orderNumber ?? '',
    orderDate: initialData ? toDateInput(initialData.orderDate) : new Date().toISOString().split('T')[0],
    itemDescription: initialData?.itemDescription ?? '',
    cost: initialData?.cost?.toString() ?? '',
    shippingCost: initialData?.shippingCost?.toString() ?? '0',
    salePrice: initialData?.salePrice?.toString() ?? '',
    buyerId: initialData?.buyerId?.toString() ?? '',
    cardId: initialData?.cardId?.toString() ?? '',
    cashbackAmount: initialData?.cashbackAmount?.toString() ?? '0',
    shippingAddress: initialData?.shippingAddress ?? '',
    notes: initialData?.notes ?? '',
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
    const cb = ((cost + shipping) * card.rewardsRate) / 100;
    set('cashbackAmount', cb.toFixed(2));
  }, [form.cardId, form.cost, form.shippingCost, cards, set]);

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
    const method = initialData ? 'PUT' : 'POST';
    const url = initialData ? `/api/orders/${initialData.id}` : '/api/orders';
    await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    router.push(returnTo ?? '/orders');
    router.refresh();
  }

  async function handleDelete() {
    if (!confirm('Delete this order?')) return;
    setDeleting(true);
    await fetch(`/api/orders/${initialData!.id}`, { method: 'DELETE' });
    router.push(returnTo ?? '/orders');
    router.refresh();
  }

  const effCost = parseAmt(form.cost) + parseAmt(form.shippingCost) - parseAmt(form.cashbackAmount);
  const pl = parseAmt(form.salePrice) - effCost;
  const fmt = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

  return (
    <form onSubmit={handleSubmit} className="space-y-6 max-w-2xl">
      {/* Platform + Order # */}
      <div className="grid grid-cols-2 gap-4">
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
      </div>

      {/* Date + Description */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Order Date</label>
          <input type="date" value={form.orderDate} onChange={e => set('orderDate', e.target.value)} className="input" required />
        </div>
        <div>
          <label className="label">Item Description <span className="text-gray-500">(optional)</span></label>
          <input type="text" value={form.itemDescription} onChange={e => set('itemDescription', e.target.value)} className="input" placeholder="What did you buy?" />
        </div>
      </div>

      {/* Cost + Shipping */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Purchase Price</label>
          <input type="text" inputMode="decimal" value={form.cost} onChange={e => set('cost', e.target.value.replace(/[^0-9.,]/g, ''))} className="input" placeholder="0.00" required />
        </div>
        <div>
          <label className="label">Shipping Fee</label>
          <input type="text" inputMode="decimal" value={form.shippingCost} onChange={e => set('shippingCost', e.target.value.replace(/[^0-9.,]/g, ''))} className="input" placeholder="0.00" />
        </div>
      </div>

      {/* Sale Price + Buyer */}
      <div className="grid grid-cols-2 gap-4">
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

      {/* Card + Cashback */}
      <div className="grid grid-cols-2 gap-4">
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
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Shipping Address <span className="text-gray-500">(optional)</span></label>
          <textarea value={form.shippingAddress} onChange={e => set('shippingAddress', e.target.value)} className="input resize-none h-20 text-sm" placeholder="Ship-to address…" />
          {initialData?.trackingNumbers && (
            <div className="mt-2">
              <p className="text-xs text-gray-500 mb-1">Tracking numbers (synced)</p>
              <div className="flex flex-wrap gap-1">
                {initialData.trackingNumbers.split(',').map(t => t.trim()).filter(Boolean).map(t => (
                  <span key={t} className="text-xs font-mono bg-gray-800 text-gray-300 px-2 py-0.5 rounded">{t}</span>
                ))}
              </div>
            </div>
          )}
        </div>
        <div>
          <label className="label">Notes <span className="text-gray-500">(optional)</span></label>
          <textarea value={form.notes} onChange={e => set('notes', e.target.value)} className="input resize-none h-20" placeholder="Any additional notes…" />
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
        {initialData && (
          <button type="button" onClick={handleDelete} disabled={deleting} className="ml-auto bg-red-900/50 hover:bg-red-900 text-red-400 px-4 py-2 rounded-md text-sm transition-colors">
            {deleting ? 'Deleting…' : 'Delete Order'}
          </button>
        )}
      </div>
    </form>
  );
}
