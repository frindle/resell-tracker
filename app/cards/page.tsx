'use client';

import { useEffect, useState } from 'react';

type MerchantRate = { id: number; merchant: string; pointsPerDollar: number };
type Card = { id: number; name: string; rewardsRate: number | null; merchantRates: MerchantRate[] };

export default function CardsPage() {
  const [cards, setCards] = useState<Card[]>([]);
  const [name, setName] = useState('');
  const [rate, setRate] = useState('');
  const [editing, setEditing] = useState<Card | null>(null);
  const [saving, setSaving] = useState(false);

  const [openRates, setOpenRates] = useState<number | null>(null);
  const [newMerchant, setNewMerchant] = useState('');
  const [newPoints, setNewPoints] = useState('');

  function load() {
    fetch('/api/cards').then(r => r.json()).then(setCards);
  }

  useEffect(() => { load(); }, []);

  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    const payload = { name: name.trim(), rewardsRate: rate.trim() !== '' ? rate : null };
    if (editing) {
      await fetch(`/api/cards/${editing.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      setEditing(null);
    } else {
      await fetch('/api/cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }
    setName('');
    setRate('');
    setSaving(false);
    load();
  }

  async function remove(id: number) {
    if (!confirm('Delete this card?')) return;
    await fetch(`/api/cards/${id}`, { method: 'DELETE' });
    if (openRates === id) setOpenRates(null);
    load();
  }

  function startEdit(c: Card) {
    setEditing(c);
    setName(c.name);
    setRate(c.rewardsRate != null ? String(c.rewardsRate) : '');
  }

  function cancelEdit() {
    setEditing(null);
    setName('');
    setRate('');
  }

  async function addMerchantRate(cardId: number) {
    if (!newMerchant.trim() || !newPoints.trim()) return;
    await fetch('/api/cards/merchant-rates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cardId, merchant: newMerchant.trim(), pointsPerDollar: newPoints }),
    });
    setNewMerchant('');
    setNewPoints('');
    load();
  }

  async function removeMerchantRate(rateId: number) {
    await fetch(`/api/cards/merchant-rates/${rateId}`, { method: 'DELETE' });
    load();
  }

  return (
    <div className="space-y-6 max-w-lg">
      <div>
        <h1 className="text-2xl font-bold">Credit Cards</h1>
        <p className="text-gray-400 text-sm mt-1">Manage cards, cashback rates, and per-merchant miles rates</p>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3">
        <h2 className="text-sm font-medium text-gray-300">{editing ? 'Edit Card' : 'Add Card'}</h2>
        <div className="flex gap-2">
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && save()}
            className="input flex-1"
            placeholder="Card name (e.g. Chase Sapphire)"
          />
          <div className="relative w-36">
            <input
              type="number"
              step="0.1"
              min="0"
              max="100"
              value={rate}
              onChange={e => setRate(e.target.value)}
              className="input w-full pr-10"
              placeholder="cashback %"
            />
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 text-sm">%</span>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={save} disabled={saving || !name.trim()} className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-4 py-2 rounded-md text-sm transition-colors">
            {saving ? 'Saving…' : editing ? 'Save Changes' : 'Add Card'}
          </button>
          {editing && (
            <button onClick={cancelEdit} className="bg-gray-800 hover:bg-gray-700 text-gray-300 px-4 py-2 rounded-md text-sm transition-colors">
              Cancel
            </button>
          )}
        </div>
      </div>

      <div className="space-y-2">
        {cards.length === 0 && <p className="text-gray-500 text-sm">No cards yet.</p>}
        {cards.map(c => (
          <div key={c.id} className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3">
              <div>
                <span className="font-medium">{c.name}</span>
                {c.rewardsRate != null
                  ? <span className="text-gray-400 text-sm ml-3">{c.rewardsRate}% cashback</span>
                  : <span className="text-gray-600 text-sm ml-3">no default rate</span>}
              </div>
              <div className="flex gap-3 items-center">
                <button
                  onClick={() => setOpenRates(openRates === c.id ? null : c.id)}
                  className="text-gray-400 hover:text-white text-xs transition-colors"
                >
                  Miles rates {c.merchantRates.length > 0 ? `(${c.merchantRates.length})` : ''}
                </button>
                <button onClick={() => startEdit(c)} className="text-gray-400 hover:text-white text-xs transition-colors">Edit</button>
                <button onClick={() => remove(c.id)} className="text-gray-500 hover:text-red-400 text-xs transition-colors">Remove</button>
              </div>
            </div>

            {openRates === c.id && (
              <div className="border-t border-gray-800 px-4 py-3 space-y-3">
                <p className="text-xs text-gray-500">Points earned per dollar at specific merchants (informational only)</p>
                <div className="flex flex-wrap gap-2">
                  {c.merchantRates.map(r => (
                    <span key={r.id} className="flex items-center gap-1 bg-gray-800 border border-gray-700 rounded-full px-3 py-1 text-xs text-gray-300">
                      {r.merchant}: {r.pointsPerDollar}x
                      <button onClick={() => removeMerchantRate(r.id)} className="text-gray-500 hover:text-red-400 ml-1 leading-none">×</button>
                    </span>
                  ))}
                  {c.merchantRates.length === 0 && <span className="text-gray-600 text-xs">No rates added yet.</span>}
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newMerchant}
                    onChange={e => setNewMerchant(e.target.value)}
                    placeholder="Merchant (e.g. Amazon)"
                    className="input flex-1 text-sm"
                  />
                  <div className="relative w-24">
                    <input
                      type="number"
                      step="0.5"
                      min="0"
                      value={newPoints}
                      onChange={e => setNewPoints(e.target.value)}
                      placeholder="3"
                      className="input w-full pr-5 text-sm"
                    />
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 text-xs">x</span>
                  </div>
                  <button
                    onClick={() => addMerchantRate(c.id)}
                    disabled={!newMerchant.trim() || !newPoints.trim()}
                    className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white px-3 py-1.5 rounded-md text-sm transition-colors"
                  >
                    Add
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
