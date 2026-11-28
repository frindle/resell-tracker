'use client';

import { useCallback, useEffect, useState } from 'react';
import { BooksShell, Off, Table, api, money } from '../ui';

type Item = { kind: string; id: number; label: string; effectCents: number };
type Rec = {
  accountId: number; accountName: string; status: string; statementCents: number | null; statementAsOf: string | null; statementSource: string | null;
  booksCents: number; diffCents: number | null; explainedCents: number; unexplainedCents: number | null; items: Item[]; openRows: number;
};
type Grid = { month: string; accounts: Rec[]; gate: { ok: boolean; skipped?: string; shortfalls?: { txnId: number }[] }; undeposited?: { ordersCents: number; openingCents: number; differenceCents: number; orders: number; preFeedOrders: number; preFeedCents: number; feedStart: string | null; goLive: string; checkStart: string; inWindow: boolean } };

const longDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
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
  /** Sets the opening's undeposited payouts to the computed figure, through the same save the Opening balances page uses. */
  async function applyAmount(cents: number) {
    const o = await api<{ input: { banks: { accountId: number; cents: number }[]; cards: { cardId: number; cents: number }[]; loans: { loanId: number; cents: number }[]; darkbloomCents: number } }>('/api/books/opening');
    if (!o.ok) { setMsg(o.data.error ?? 'failed'); return; }
    const x = o.data.input, d = (c: number) => (c / 100).toFixed(2);
    const r = await api('/api/books/opening', 'POST', {
      banks: x.banks.map(b => ({ accountId: b.accountId, amount: d(b.cents) })), cards: x.cards.map(c => ({ cardId: c.cardId, amount: d(c.cents) })),
      loans: x.loans.map(l => ({ loanId: l.loanId, amount: d(l.cents) })), darkbloom: d(x.darkbloomCents), undeposited: d(cents),
    });
    setMsg(r.ok ? '' : r.data.error ?? 'failed');
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
      {grid?.undeposited && !grid.undeposited.inWindow && <div className="text-xs text-gray-500">Go-live check runs from {longDay(grid.undeposited.checkStart)}.</div>}
      {grid?.undeposited && grid.undeposited.inWindow && grid.undeposited.preFeedOrders > 0 && (
        <div className="text-xs text-gray-400">{grid.undeposited.preFeedOrders} order{grid.undeposited.preFeedOrders === 1 ? ' was' : 's were'} ({money(grid.undeposited.preFeedCents)}) paid before your bank history starts{grid.undeposited.feedStart ? ` (${longDay(grid.undeposited.feedStart)})` : ''}; treated as deposited.</div>
      )}
      {grid?.undeposited && grid.undeposited.inWindow && grid.undeposited.differenceCents !== 0 && (
        <div className="text-sm text-amber-300 border border-amber-700 rounded-md p-3 space-y-2">
          <div>
            Your opening balance has {money(grid.undeposited.openingCents)} for payouts not yet deposited, but {grid.undeposited.orders} order{grid.undeposited.orders === 1 ? '' : 's'} paid before go-live and not yet deposited add up to {money(grid.undeposited.ordersCents)}. Click Use this amount to set the opening to {money(grid.undeposited.ordersCents)}.
          </div>
          <button className="border border-amber-700 text-amber-200 px-3 py-1 rounded-md" onClick={() => applyAmount(grid.undeposited!.ordersCents)}>Use this amount</button>
        </div>
      )}
      {grid && grid.gate.shortfalls && grid.gate.shortfalls.length > 0 && <div className="text-sm text-amber-300">{grid.gate.shortfalls.length} deposit shortfall{grid.gate.shortfalls.length === 1 ? '' : 's'} open this month (Bank feed, Shortfalls tab).</div>}
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
