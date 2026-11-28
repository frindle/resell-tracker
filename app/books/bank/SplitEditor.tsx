'use client';
// Split one open bank row into parts: each part is an amount plus an order (or a return, for a credit), Personal, or a cost entry.
// The server checks that the parts add up to the row and writes them in one go.
import { useState } from 'react';

type Part = { amount: string; kind: 'order' | 'personal' | 'cost'; ref: string; category: string; business: string };
export type SplitRow = { id: number; amountCents: number; description: string; mapped: boolean };

const toCents = (s: string): number | null => {
  const m = /^\$?\s*(\d+)(?:\.(\d{1,2}))?$/.exec(s.trim());
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || 0) : null;
};
const money = (c: number) => `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toFixed(2)}`;

/** "#12" is an order id, "r#7" a return id, anything else an order number (the same as the Link box). */
function orderRef(v: string): Record<string, unknown> {
  const x = v.trim();
  const r = /^r#(\d+)$/i.exec(x); if (r) return { returnId: Number(r[1]) };
  const o = /^#(\d+)$/.exec(x); if (o) return { orderId: Number(o[1]) };
  return { orderNumber: x };
}

export default function SplitEditor({ row, cats, busy, onSubmit, onCancel }: {
  row: SplitRow; cats: string[]; busy: boolean; onSubmit: (parts: Record<string, unknown>[]) => void; onCancel: () => void;
}) {
  const credit = row.amountCents > 0, total = Math.abs(row.amountCents);
  const blank = (): Part => ({ amount: '', kind: 'order', ref: '', category: cats[0] ?? '', business: 'resell' });
  const [parts, setParts] = useState<Part[]>([blank(), { ...blank(), kind: 'personal' }]);
  const set = (i: number, patch: Partial<Part>) => setParts(ps => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const cents = parts.map(p => toCents(p.amount));
  const sum = cents.reduce<number>((a, c) => a + (c ?? 0), 0);
  const left = total - sum;
  const ready = parts.length >= 2 && cents.every(c => c != null && c > 0) && left === 0
    && parts.every(p => (p.kind === 'order' ? p.ref.trim() !== '' : p.kind === 'cost' ? p.category !== '' : true));
  const send = () => onSubmit(parts.map((p, i) => ({
    cents: cents[i], kind: p.kind,
    ...(p.kind === 'order' ? orderRef(p.ref) : {}),
    ...(p.kind === 'cost' ? { category: p.category, business: p.business } : {}),
  })));
  return (
    <div className="border border-gray-700 rounded-md p-3 space-y-2 text-sm">
      <div className="font-medium text-white">Split row #{row.id} ({money(total)}, {row.description})</div>
      <div className="text-xs text-gray-500">
        Each part is an amount and where it went. An order part counts toward that order&apos;s paid amount; Personal posts as {credit ? 'an owner contribution' : 'an owner draw'}.
        {!credit && ' A cost part makes a cost entry for that amount.'} The parts must add up to the row. Undo removes all of them.
      </div>
      {parts.map((p, i) => (
        <div key={i} className="flex flex-wrap gap-2 items-center">
          <input className="input w-24" inputMode="decimal" placeholder="amount" aria-label={`Part ${i + 1} amount`} value={p.amount} onChange={e => set(i, { amount: e.target.value })} />
          <select className="input" aria-label={`Part ${i + 1} target`} value={p.kind} onChange={e => set(i, { kind: e.target.value as Part['kind'] })}>
            <option value="order">{credit ? 'Order refund' : 'Order'}</option>
            <option value="personal">Personal</option>
            {!credit && row.mapped && <option value="cost">Cost entry</option>}
          </select>
          {p.kind === 'order' && <input className="input w-44" aria-label={`Part ${i + 1} order`} value={p.ref} onChange={e => set(i, { ref: e.target.value })} placeholder={credit ? 'order number, #id or r#return' : 'order number or #id'} />}
          {p.kind === 'cost' && <>
            <select className="input" value={p.category} onChange={e => set(i, { category: e.target.value })}>{cats.map(k => <option key={k} value={k}>{k}</option>)}</select>
            <select className="input" value={p.business} onChange={e => set(i, { business: e.target.value })}><option value="resell">Resell</option><option value="shared">Shared</option></select>
          </>}
          {parts.length > 2 && <button className="text-gray-400" aria-label={`Remove part ${i + 1}`} onClick={() => setParts(ps => ps.filter((_, j) => j !== i))}>×</button>}
          {i === parts.length - 1 && cents[i] == null && left > 0 && <button className="text-blue-400" onClick={() => set(i, { amount: (left / 100).toFixed(2) })}>Use the rest ({money(left)})</button>}
        </div>
      ))}
      <div className={`text-xs ${left === 0 ? 'text-green-400' : 'text-amber-300'}`}>{left === 0 ? 'Adds up to the row.' : left > 0 ? `${money(left)} left to place.` : `${money(-left)} over the row.`}</div>
      <div className="flex gap-2">
        <button className="text-blue-400" onClick={() => setParts(ps => [...ps, blank()])}>Add a part</button>
        <button disabled={busy || !ready} className="bg-blue-600 text-white px-3 py-1 rounded-md disabled:opacity-50" onClick={send}>Split</button>
        <button className="text-gray-400" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
