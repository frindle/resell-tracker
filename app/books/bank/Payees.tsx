'use client';

import { useCallback, useEffect, useState } from 'react';
import { Table, api } from '../ui';

type Payee = { id: number; token: string; buyerId: number | null; buyer: string | null; shared: boolean; createdAt: string };
const fetchPayees = () => api<{ payees: Payee[] }>('/api/books/bank/payees');

/** The Payers tab: ACH / direct deposit names learned from accepted deposits, and the buyer each one narrows to. */
export default function Payees({ onChanged }: { onChanged: () => void }) {
  const [rows, setRows] = useState<Payee[] | null>(null);
  const [msg, setMsg] = useState('');
  const show = useCallback((r: Awaited<ReturnType<typeof fetchPayees>>) => {
    if (r.ok) setRows(r.data.payees); else setMsg(`Could not load: ${r.data.error ?? 'error'}`);
  }, []);
  const load = useCallback(async () => show(await fetchPayees()), [show]);
  useEffect(() => {
    let live = true;
    fetchPayees().then(r => { if (live) show(r); });
    return () => { live = false; };
  }, [show]);
  const del = async (p: Payee) => {
    if (!confirm(`Forget the payer name "${p.token}"? Deposits from it go back to suggesting every buyer until you accept one again.`)) return;
    const r = await api<{ error?: string }>(`/api/books/bank/payees/${p.id}`, 'DELETE');
    setMsg(r.ok ? '' : `Failed: ${r.data.error}`);
    await load(); onChanged();
  };
  if (!rows) return <div className="text-sm text-gray-500">{msg || 'Loading...'}</div>;
  return (
    <div className="space-y-2">
      {msg && <div className="text-xs text-red-400">{msg}</div>}
      <h2 className="text-sm font-medium text-white">Payer names</h2>
      <p className="text-xs text-gray-500">Learned when you accept a deposit for one buyer, from ACH and direct deposit descriptions only. A known name narrows later deposits to that buyer&apos;s orders, and only a known name can auto-match. Zelle, PayPal, Venmo, checks and transfers are never learned: those deposits always list every buyer. A name accepted for two different buyers is shared and narrows nothing. To keep a deposit that is not a payout out of the books, mark it Personal on the Transactions tab, or make a Personal rule from it so the next one is handled for you.</p>
      {rows.length === 0 ? <div className="text-xs text-gray-500">None learned yet.</div> : (
        <Table head={['Payer name', 'Buyer', '']} rows={rows.map(p => [
          <span key="t" className="font-mono text-xs">{p.token}</span>,
          p.shared ? <span key="b" className="text-amber-300">shared by several buyers, not used</span> : (p.buyer ?? `buyer #${p.buyerId}`),
          <button key="d" className="text-red-300 text-xs" onClick={() => del(p)}>Delete</button>,
        ])} />
      )}
    </div>
  );
}
