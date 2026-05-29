'use client';

import { useEffect, useState } from 'react';

type Buyer = { id: number; name: string; createdAt: string };

export default function BuyersPage() {
  const [buyers, setBuyers] = useState<Buyer[]>([]);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  function load() {
    fetch('/api/buyers').then(r => r.json()).then(setBuyers);
  }

  useEffect(() => { load(); }, []);

  async function add() {
    if (!name.trim()) return;
    setSaving(true);
    await fetch('/api/buyers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() }),
    });
    setName('');
    setSaving(false);
    load();
  }

  async function remove(id: number) {
    if (!confirm('Delete this buyer?')) return;
    await fetch(`/api/buyers/${id}`, { method: 'DELETE' });
    load();
  }

  return (
    <div className="space-y-6 max-w-md">
      <div>
        <h1 className="text-2xl font-bold">Buyers</h1>
        <p className="text-gray-400 text-sm mt-1">Manage buyer labels</p>
      </div>

      <div className="flex gap-2">
        <input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && add()}
          className="input flex-1"
          placeholder="Buyer name"
        />
        <button onClick={add} disabled={saving || !name.trim()} className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-4 py-2 rounded-md text-sm transition-colors">
          Add
        </button>
      </div>

      <div className="space-y-2">
        {buyers.length === 0 && (
          <p className="text-gray-500 text-sm">No buyers yet.</p>
        )}
        {buyers.map(b => (
          <div key={b.id} className="flex items-center justify-between bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
            <span>{b.name}</span>
            <button onClick={() => remove(b.id)} className="text-gray-500 hover:text-red-400 text-xs transition-colors">Remove</button>
          </div>
        ))}
      </div>
    </div>
  );
}
