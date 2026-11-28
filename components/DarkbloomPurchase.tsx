'use client';

import { useEffect, useState } from 'react';

const CATEGORIES = [
  ['supplies', 'Supplies'], ['hardware', 'Hardware (machines, parts to depreciate)'], ['software', 'Software'],
  ['internet', 'Internet'], ['electricity', 'Electricity'], ['other', 'Other'],
] as const;

export type DarkbloomFields = { id: number; darkbloomCategory: string | null; bloomEntryId: number | null; bloomPushNote: string | null };

function statusText(o: DarkbloomFields): string {
  if (o.darkbloomCategory == null) return '';
  if (o.bloomEntryId != null && !o.bloomPushNote) return `In bloom-ledger as entry ${o.bloomEntryId}`;
  const n = o.bloomPushNote ?? '';
  if (n === 'items') return 'Waiting for item details from the merchant page';
  if (n === 'no-key' || n === 'no-ledger') return 'Pending push: set the bloom-ledger address and key';
  if (n === 'auth') return 'Pending push: the ledger refused the key';
  if (n === 'amount') return 'Waiting for the amount paid';
  return n ? `Push failed: ${n}` : 'Pending push';
}

/** "Darkbloom purchase" action for one order: category picker (machine picker for hardware), Not Darkbloom to undo, push status. */
export default function DarkbloomPurchase({ order, onDone }: { order: DarkbloomFields; onDone: () => void }) {
  const [category, setCategory] = useState(order.darkbloomCategory ?? 'supplies');
  const [machineId, setMachineId] = useState('');
  const [machines, setMachines] = useState<{ id: string; label: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const marked = order.darkbloomCategory != null;

  useEffect(() => {
    if (category !== 'hardware') return;
    fetch('/api/orders/darkbloom').then(r => r.json()).then(d => setMachines(Array.isArray(d.machines) ? d.machines : [])).catch(() => setMachines([]));
  }, [category]);

  async function send(body: Record<string, unknown>) {
    setBusy(true); setErr('');
    try {
      const r = await fetch('/api/orders/darkbloom', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [order.id], ...body }) });
      const d = await r.json();
      if (d.error) setErr(d.error); else onDone();
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  }

  const status = statusText(order);
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <select value={category} onChange={e => setCategory(e.target.value)} disabled={busy} className="bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-gray-200" aria-label="Darkbloom category">
        {CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      {category === 'hardware' && (
        <select value={machineId} onChange={e => setMachineId(e.target.value)} disabled={busy} className="bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-gray-200" aria-label="Machine">
          <option value="">No machine picked</option>
          {machines.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      )}
      <button disabled={busy} onClick={() => send({ action: 'mark', category, ...(category === 'hardware' && machineId ? { machineId } : {}) })}
        className="bg-indigo-700 hover:bg-indigo-600 disabled:opacity-40 text-white px-2.5 py-1 rounded">
        {marked ? 'Update Darkbloom purchase' : 'Darkbloom purchase'}
      </button>
      {marked && <button disabled={busy} onClick={() => send({ action: 'unmark' })} className="bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white px-2.5 py-1 rounded">Not Darkbloom</button>}
      {marked && order.bloomEntryId == null && <button disabled={busy} onClick={() => send({ action: 'items' })} className="text-blue-400 hover:underline disabled:opacity-40">Fetch item details</button>}
      {status && <span className="text-gray-400">{status}</span>}
      {err && <span className="text-red-400">{err}</span>}
    </div>
  );
}
