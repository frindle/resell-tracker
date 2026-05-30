'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';

type Buyer = { id: number; name: string };
type Card = { id: number; name: string; rewardsRate: number };

type OrderFormProps = {
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
    notes: string | null;
  };
};

const PLATFORMS = ['Amazon', 'Walmart', 'Other'];

function toDateInput(iso: string) {
  return iso.split('T')[0];
}

export default function OrderForm({ initialData }: OrderFormProps) {
  const router = useRouter();
  const [buyers, setBuyers] = useState<Buyer[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [newBuyer, setNewBuyer] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

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
    notes: initialData?.notes ?? '',
  });

  useEffect(() => {
    fetch('/api/buyers').then(r => r.json()).then(setBuyers);
    fetch('/api/cards').then(r => r.json()).then(setCards);
  }, []);

  const set = useCallback((field: string, value: string) => {
    setForm(prev => ({ ...prev, [field]: value }));
  }, []);

  // Auto-calculate cashback when card or cost changes
  useEffect(() => {
    if (!form.cardId) return;
    const card = cards.find(c => c.id === parseInt(form.cardId));
    if (!card) return;
    const cost = parseFloat(form.cost) || 0;
    const shipping = parseFloat(form.shippingCost) || 0;
    const cb = ((cost + shipping) * card.rewardsRate) / 100;
    set('cashbackAmount', cb.toFixed(2));
  }, [form.cardId, form.cost, form.shippingCost, cards, set]);

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
    router.push('/orders');
    router.refresh();
  }

  async function handleDelete() {
    if (!confirm('Delete this order?')) return;
    setDeleting(true);
    await fetch(`/api/orders/${initialData!.id}`, { method: 'DELETE' });
    router.push('/orders');
    router.refresh();
  }

  const effCost = (parseFloat(form.cost) || 0) + (parseFloat(form.shippingCost) || 0) - (parseFloat(form.cashbackAmount) || 0);
  const pl = (parseFloat(form.salePrice) || 0) - effCost;
  const fmt = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

  return (
    <form onSubmit={handleSubmit} className="space-y-6 max-w-2xl">
      {/* Platform + Order # */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Platform</label>
          <select value={form.platform} onChange={e => set('platform', e.target.value)} className="input">
            {PLATFORMS.map(p => <option key={p}>{p}</option>)}
          </select>
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
          <input type="number" step="0.01" min="0" value={form.cost} onChange={e => set('cost', e.target.value)} className="input" placeholder="0.00" required />
        </div>
        <div>
          <label className="label">Shipping In</label>
          <input type="number" step="0.01" min="0" value={form.shippingCost} onChange={e => set('shippingCost', e.target.value)} className="input" placeholder="0.00" />
        </div>
      </div>

      {/* Sale Price + Buyer */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Sale Price</label>
          <input type="number" step="0.01" min="0" value={form.salePrice} onChange={e => set('salePrice', e.target.value)} className="input" placeholder="0.00" required />
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
              <option key={c.id} value={c.id}>{c.name} ({c.rewardsRate}%)</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Cashback Amount</label>
          <input type="number" step="0.01" min="0" value={form.cashbackAmount} onChange={e => set('cashbackAmount', e.target.value)} className="input" placeholder="0.00" />
          <p className="text-xs text-gray-500 mt-1">Auto-filled from card rate, edit if needed</p>
        </div>
      </div>

      {/* Notes */}
      <div>
        <label className="label">Notes <span className="text-gray-500">(optional)</span></label>
        <textarea value={form.notes} onChange={e => set('notes', e.target.value)} className="input resize-none h-20" placeholder="Any additional notes…" />
      </div>

      {/* P&L Preview */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 flex gap-6 text-sm">
        <div>
          <span className="text-gray-400">Eff. Cost</span>
          <span className="ml-2 font-medium">{fmt(effCost)}</span>
        </div>
        <div>
          <span className="text-gray-400">Sale</span>
          <span className="ml-2 font-medium">{fmt(parseFloat(form.salePrice) || 0)}</span>
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
