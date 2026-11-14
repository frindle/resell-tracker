'use client';

import { useCallback, useEffect, useState } from 'react';
import { Table, api, money } from '../ui';

type Deposit = { txnId: number; shortCents: number; orders: { orderId: number; shortCents: number }[]; postedDate: string; description: string; amountCents: number };
type Brief = { orderId: number; orderNumber: string | null; platform: string; item: string | null; buyer: string | null; paidDay: string; paidCents: number; openCents: number };
type Aging = { buyerId: number | null; buyer: string | null; totalCents: number; oldestDay: string; orders: { orderId: number; paidDay: string; openCents: number; partial: boolean }[] };
type Known = Brief & { saleCents: number; shortCents: number };
type Dbm = { months: { month: string; earnedCents: number; receivedCents: number; pieces: number; owedCents: number }[]; balanceCents: number };
type Data = { deposits: Deposit[]; aging: Aging[]; known: Known[]; darkbloom: Dbm };

/** The Shortfalls tab: deposits that paid less than the orders were owed, orders waiting too long, known short payouts, Darkbloom. */
export default function Shortfalls({ onChanged }: { onChanged: () => void }) {
  const [d, setD] = useState<Data | null>(null);
  const [msg, setMsg] = useState('');
  const load = useCallback(async () => { const r = await api<Data>('/api/books/bank/shortfalls'); if (r.ok) setD(r.data as unknown as Data); else setMsg(`Could not load: ${(r.data as { error?: string }).error ?? 'error'}`); }, []);
  useEffect(() => { load(); }, [load]);
  const act = async (txnId: number, body: Record<string, unknown>) => {
    const r = await api<{ error?: string }>(`/api/books/bank/transactions/${txnId}`, 'PATCH', body);
    setMsg(r.ok ? '' : `Failed: ${r.data.error}`);
    await load(); onChanged();
  };
  if (!d) return <div className="text-sm text-gray-500">{msg || 'Loading...'}</div>;
  return (
    <div className="space-y-6">
      {msg && <div className="text-xs text-red-400">{msg}</div>}

      <div className="space-y-2">
        <h2 className="text-sm font-medium text-white">Deposit shortfalls</h2>
        <p className="text-xs text-gray-500">A deposit that paid less than the orders it was linked to. Fee posts the difference to commissions, Returns to returns and allowances, More coming leaves the order undeposited (it shows in aging below), Wrong match undoes the link. A month cannot lock while one is open.</p>
        {d.deposits.length === 0 ? <div className="text-xs text-gray-500">None open.</div> : (
          <Table head={['Date', 'Deposit', 'Short', 'Orders', 'Choose']} rows={d.deposits.map(x => [
            x.postedDate,
            <div key="d"><div>{money(x.amountCents)}</div><div className="text-xs text-gray-500">{x.description}</div></div>,
            <span key="s" className="text-amber-300">{money(x.shortCents)}</span>,
            x.orders.map(o => `#${o.orderId} (${money(o.shortCents)})`).join(', '),
            <div key="c" className="flex flex-wrap gap-2 text-xs">
              <button className="text-blue-400" onClick={() => act(x.txnId, { action: 'shortfall', choice: 'fee' })}>Fee</button>
              <button className="text-blue-400" onClick={() => act(x.txnId, { action: 'shortfall', choice: 'returns' })}>Returns</button>
              <button className="text-blue-400" onClick={() => act(x.txnId, { action: 'shortfall', choice: 'more' })}>More coming</button>
              <button className="text-gray-400" onClick={() => act(x.txnId, { action: 'reset' })}>Wrong match</button>
            </div>,
          ])} />
        )}
      </div>

      <div className="space-y-2">
        <h2 className="text-sm font-medium text-white">Paid, not deposited (over 21 days)</h2>
        {d.aging.length === 0 ? <div className="text-xs text-gray-500">Nothing is overdue.</div> : d.aging.map(g => (
          <div key={String(g.buyerId)} className="space-y-1">
            <div className="text-sm text-gray-200">{g.buyer ?? 'No buyer'}: {money(g.totalCents)} over {g.orders.length} order{g.orders.length === 1 ? '' : 's'}, oldest paid {g.oldestDay}</div>
            <div className="text-xs text-gray-500">{g.orders.map(o => `#${o.orderId} ${o.paidDay} ${money(o.openCents)}${o.partial ? ' (rest)' : ''}`).join('; ')}</div>
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <h2 className="text-sm font-medium text-white">Short payouts the sync already knew about</h2>
        <p className="text-xs text-gray-500">Final payout was less than the sale price. Already booked to returns and allowances; listed for information.</p>
        {d.known.length === 0 ? <div className="text-xs text-gray-500">None.</div> : (
          <Table head={['Order', 'Buyer', 'Paid', 'Sale', 'Short']} rows={d.known.map(k => [
            `#${k.orderId}${k.orderNumber ? ` ${k.orderNumber}` : ''}`, k.buyer ?? '-', `${k.paidDay} ${money(k.paidCents)}`, money(k.saleCents), money(k.shortCents),
          ])} />
        )}
      </div>

      <div className="space-y-2">
        <h2 className="text-sm font-medium text-white">Darkbloom balance and payouts received</h2>
        <p className="text-xs text-gray-500">Added: earnings less API spend on the Darkbloom balance (1500). Received: payouts you linked from the bank feed, any number of pieces. Still owed is the running 1500 balance, {money(d.darkbloom.balanceCents)} now. Link a piece with More, Darkbloom payout on a credit row.</p>
        {d.darkbloom.months.length === 0 ? <div className="text-xs text-gray-500">No Darkbloom activity yet.</div> : (
          <Table head={['Month', 'Added', 'Received', 'Pieces', 'Still owed']} rows={d.darkbloom.months.map(m => [m.month, money(m.earnedCents), money(m.receivedCents), String(m.pieces), money(m.owedCents)])} />
        )}
      </div>
    </div>
  );
}
