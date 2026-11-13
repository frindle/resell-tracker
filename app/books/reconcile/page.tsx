'use client';

import { useCallback, useEffect, useState } from 'react';
import { BooksShell, Off, Table, api, money } from '../ui';

type Item = { kind: string; id: number; label: string; effectCents: number };
type Rec = {
  accountId: number; accountName: string; status: string; statementCents: number | null; statementAsOf: string | null; statementSource: string | null;
  booksCents: number; diffCents: number | null; explainedCents: number; unexplainedCents: number | null; items: Item[]; openRows: number;
};
type Grid = { month: string; accounts: Rec[]; gate: { ok: boolean; skipped?: string } };

const thisMonth = () => new Date().toISOString().slice(0, 7);
const STATUS: Record<string, string> = { tied: 'Ties', explained: 'Ties with items in transit', unexplained: 'Does not tie', no_balance: 'No statement balance', empty: 'Nothing to reconcile' };

export default function ReconcilePage() {
  const [month, setMonth] = useState(thisMonth());
  const [grid, setGrid] = useState<Grid | null>(null);
  const [off, setOff] = useState(false);
  const [posting, setPosting] = useState(false);
  const [msg, setMsg] = useState('');
  const load = useCallback(async () => {
    const [g, s] = await Promise.all([api<Grid>(`/api/books/bank/reconcile?month=${month}`), api<{ bankPosting: boolean }>('/api/books/status')]);
    if (!g.ok && !s.ok) { setOff(true); return; }
    if (g.ok) setGrid(g.data as unknown as Grid);
    if (s.ok) setPosting(!!s.data.bankPosting);
  }, [month]);
  useEffect(() => { load(); }, [load]);

  async function togglePosting() {
    const next = !posting;
    if (next && !confirm('Turn on bank posting? Linked bank rows will post to the books (transfers, card payments, personal spending, and tax fill from card charges). Turning it off reverses them on the next reconcile.')) return;
    const r = await api('/api/books/status', 'POST', { bankPosting: next });
    setMsg(r.ok ? '' : r.data.error ?? 'failed');
    if (r.ok) await api('/api/books/reconcile', 'POST');
    load();
  }
  async function addBalance(accountId: number) {
    const date = prompt('Statement date (YYYY-MM-DD)?', month + '-28');
    if (!date) return;
    const amt = prompt('Balance on that date in dollars (a card that owes money is negative)?');
    if (amt == null || amt.trim() === '' || Number.isNaN(Number(amt))) return;
    const r = await api('/api/books/bank/balances', 'POST', { accountId, date, balanceCents: Math.round(Number(amt) * 100) });
    setMsg(r.ok ? '' : r.data.error ?? 'failed');
    load();
  }

  if (off) return <BooksShell title="Reconcile"><Off /></BooksShell>;
  return (
    <BooksShell title="Reconcile">
      <p className="text-sm text-gray-400">For each account in your books, the bank&apos;s balance at month end against the books, with the items still in transit that explain any gap. A month that does not tie cannot be locked without a reason.</p>
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label className="text-xs text-gray-400 space-y-1"><span>Month</span><input className="input" value={month} onChange={e => setMonth(e.target.value)} placeholder="YYYY-MM" /></label>
        <button className="border border-gray-600 text-gray-200 px-3 py-1.5 rounded-md" onClick={togglePosting}>Bank posting: {posting ? 'on' : 'off'}</button>
        {grid && <span className={grid.gate.ok ? 'text-green-300' : 'text-amber-300'}>{grid.gate.skipped ? `Lock gate off (${grid.gate.skipped})` : grid.gate.ok ? 'Ready to lock' : 'Not ready to lock'}</span>}
        {msg && <span className="text-xs text-red-400">{msg}</span>}
      </div>
      {grid && grid.accounts.length === 0 && <div className="text-sm text-gray-500">No bank account is linked to a card or ledger account yet. Link them on the Bank feed tab.</div>}
      {grid?.accounts.map(a => (
        <div key={a.accountId} className="border border-gray-800 rounded-md p-3 space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-sm font-medium text-white">{a.accountName}</h2>
            <span className={a.status === 'unexplained' || a.status === 'no_balance' ? 'text-amber-300 text-sm' : 'text-green-300 text-sm'}>{STATUS[a.status] ?? a.status}</span>
            <button className="text-xs text-blue-400" onClick={() => addBalance(a.accountId)}>Type a statement balance</button>
          </div>
          <div className="text-sm text-gray-300 grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div><div className="text-xs text-gray-500">Statement{a.statementAsOf ? ` (${a.statementSource}, ${a.statementAsOf})` : ''}</div>{a.statementCents == null ? '-' : money(a.statementCents)}</div>
            <div><div className="text-xs text-gray-500">Books</div>{money(a.booksCents)}</div>
            <div><div className="text-xs text-gray-500">In transit</div>{money(a.explainedCents)}</div>
            <div><div className="text-xs text-gray-500">Unexplained</div>{a.unexplainedCents == null ? '-' : money(a.unexplainedCents)}</div>
          </div>
          {a.items.length > 0 && <Table head={['In transit', 'Effect']} rows={a.items.map(i => [i.label, money(i.effectCents)])} />}
        </div>
      ))}
    </BooksShell>
  );
}
