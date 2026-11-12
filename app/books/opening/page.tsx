'use client';

import { useCallback, useEffect, useState } from 'react';
import { BooksShell, Off, api, money } from '../ui';

type Data = {
  goLive: string;
  input: { banks: { accountId: number; cents: number }[]; cards: { cardId: number; cents: number }[]; loans: { loanId: number; cents: number }[]; darkbloomCents: number; undepositedCents: number };
  banks: { id: number; code: string; name: string }[]; cards: { id: number; name: string }[]; loans: { id: number; name: string }[];
  preview: { inventoryCents: number; receivableCents: number };
};
const d = (c: number | undefined) => (c ? (c / 100).toFixed(2) : '');

export default function OpeningPage() {
  const [data, setData] = useState<Data | null>(null);
  const [off, setOff] = useState(false);
  const [v, setV] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    const r = await api<Data>('/api/books/opening');
    if (!r.ok) { setOff(true); return; }
    const x = r.data as Data;
    setData(x);
    const init: Record<string, string> = { darkbloom: d(x.input.darkbloomCents), undeposited: d(x.input.undepositedCents) };
    x.input.banks.forEach(b => { init[`b${b.accountId}`] = d(b.cents); });
    x.input.cards.forEach(c => { init[`c${c.cardId}`] = d(c.cents); });
    x.input.loans.forEach(l => { init[`l${l.loanId}`] = d(l.cents); });
    setV(init);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function save() {
    if (!data) return;
    const r = await api('/api/books/opening', 'POST', {
      banks: data.banks.map(b => ({ accountId: b.id, amount: v[`b${b.id}`] })),
      cards: data.cards.map(c => ({ cardId: c.id, amount: v[`c${c.id}`] })),
      loans: data.loans.map(l => ({ loanId: l.id, amount: v[`l${l.id}`] })),
      darkbloom: v.darkbloom, undeposited: v.undeposited,
    });
    setMsg(r.ok ? 'Saved. The previous opening entry was reversed and a new one posted.' : `Failed: ${r.data.error}`);
    load();
  }
  const row = (label: string, key: string) => (
    <label key={key} className="flex items-center justify-between gap-3 text-sm text-gray-300"><span>{label}</span>
      <input className="input w-40 text-right" value={v[key] ?? ''} onChange={e => setV({ ...v, [key]: e.target.value })} placeholder="0.00" /></label>
  );
  if (off) return <BooksShell title="Opening balances"><Off /></BooksShell>;
  if (!data) return <BooksShell title="Opening balances"><div className="text-sm text-gray-500">Loading...</div></BooksShell>;
  return (
    <BooksShell title="Opening balances">
      <p className="text-sm text-gray-400">As of the day before go-live ({data.goLive}). Inventory and receivables for orders placed before go-live are computed from your orders; the difference goes to Opening balance equity. Saving again replaces the previous opening entry.</p>
      <div className="text-sm text-gray-300">From orders: inventory {money(data.preview.inventoryCents)}, receivables {money(data.preview.receivableCents)}</div>
      <div className="max-w-md space-y-2">
        <h2 className="text-sm font-medium text-gray-300 pt-2">Bank and cash (add accounts on the Costs tab)</h2>
        {data.banks.length === 0 && <div className="text-xs text-gray-500">No bank accounts yet.</div>}
        {data.banks.map(b => row(`${b.code} ${b.name}`, `b${b.id}`))}
        <h2 className="text-sm font-medium text-gray-300 pt-2">Other assets</h2>
        {row('Payouts received, not yet deposited', 'undeposited')}
        {row('Darkbloom balance', 'darkbloom')}
        <h2 className="text-sm font-medium text-gray-300 pt-2">Credit card balances owed</h2>
        {data.cards.map(c => row(c.name, `c${c.id}`))}
        <h2 className="text-sm font-medium text-gray-300 pt-2">Loan balances owed</h2>
        {data.loans.map(l => row(l.name, `l${l.id}`))}
        <button className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-3 py-1.5 rounded-md mt-2" onClick={save}>Save opening balances</button>
        {msg && <div className="text-xs text-gray-400">{msg}</div>}
      </div>
    </BooksShell>
  );
}
