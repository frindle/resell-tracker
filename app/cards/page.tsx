'use client';

import { useEffect, useState } from 'react';

type Card = { id: number; name: string; rewardsRate: number };

export default function CardsPage() {
  const [cards, setCards] = useState<Card[]>([]);
  const [name, setName] = useState('');
  const [rate, setRate] = useState('');
  const [editing, setEditing] = useState<Card | null>(null);
  const [saving, setSaving] = useState(false);

  function load() {
    fetch('/api/cards').then(r => r.json()).then(setCards);
  }

  useEffect(() => { load(); }, []);

  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    if (editing) {
      await fetch(`/api/cards/${editing.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), rewardsRate: parseFloat(rate) || 0 }),
      });
      setEditing(null);
    } else {
      await fetch('/api/cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), rewardsRate: parseFloat(rate) || 0 }),
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
    load();
  }

  function startEdit(c: Card) {
    setEditing(c);
    setName(c.name);
    setRate(String(c.rewardsRate));
  }

  function cancelEdit() {
    setEditing(null);
    setName('');
    setRate('');
  }

  return (
    <div className="space-y-6 max-w-md">
      <div>
        <h1 className="text-2xl font-bold">Credit Cards</h1>
        <p className="text-gray-400 text-sm mt-1">Manage cards and their default cashback rates</p>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3">
        <h2 className="text-sm font-medium text-gray-300">{editing ? 'Edit Card' : 'Add Card'}</h2>
        <div className="flex gap-2">
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            className="input flex-1"
            placeholder="Card name (e.g. Chase Sapphire)"
          />
          <div className="relative w-28">
            <input
              type="number"
              step="0.1"
              min="0"
              max="100"
              value={rate}
              onChange={e => setRate(e.target.value)}
              className="input w-full pr-6"
              placeholder="5.0"
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
          <div key={c.id} className="flex items-center justify-between bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
            <div>
              <span className="font-medium">{c.name}</span>
              <span className="text-gray-400 text-sm ml-3">{c.rewardsRate}% cashback</span>
            </div>
            <div className="flex gap-3">
              <button onClick={() => startEdit(c)} className="text-gray-400 hover:text-white text-xs transition-colors">Edit</button>
              <button onClick={() => remove(c.id)} className="text-gray-500 hover:text-red-400 text-xs transition-colors">Remove</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
