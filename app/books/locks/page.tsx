'use client';

import { useCallback, useEffect, useState } from 'react';
import { BooksShell, Off, Table, api } from '../ui';

export default function LocksPage() {
  const [locks, setLocks] = useState<{ month: string }[]>([]);
  const [off, setOff] = useState(false);
  const [month, setMonth] = useState('');
  const [err, setErr] = useState('');
  const load = useCallback(async () => {
    const r = await api<{ month: string }[]>('/api/books/locks');
    if (!r.ok) setOff(true); else setLocks(r.data as unknown as { month: string }[]);
  }, []);
  useEffect(() => { load(); }, [load]);
  const [gate, setGate] = useState<{ problems: { accountName: string; status: string; unexplainedCents: number | null; openRows: number }[]; shortfalls?: { txnId: number; postedDate: string; shortCents: number }[] } | null>(null);
  async function lock(force?: string) {
    const r = await api<{ gate?: typeof gate }>('/api/books/locks', 'POST', { month, ...(force ? { force: true, reason: force } : {}) });
    setErr(r.ok ? '' : r.data.error ?? 'failed');
    setGate(r.ok ? null : (r.data as { gate?: typeof gate }).gate ?? null);
    if (r.ok) setMonth('');
    load();
  }
  function lockAnyway() {
    const reason = prompt(`Lock ${month} even though it does not tie? This is recorded in the audit log. Reason:`);
    if (reason && reason.trim()) lock(reason.trim());
  }
  async function unlock(m: string) {
    const reason = prompt(`Unlock ${m}? Unlocking is recorded in the audit log. Reason:`);
    if (reason === null) return;
    await api('/api/books/locks', 'DELETE', { month: m, reason }); load();
  }
  if (off) return <BooksShell title="Period locks"><Off /></BooksShell>;
  return (
    <BooksShell title="Period locks">
      <p className="text-sm text-gray-400">A locked month accepts no new postings. Anything that would land there is re-dated to the first day of the next open month, with the original date in the memo.</p>
      <div className="flex items-end gap-2">
        <label className="text-xs text-gray-400 space-y-1"><span>Lock month</span><input className="input" value={month} onChange={e => setMonth(e.target.value)} placeholder="YYYY-MM" /></label>
        <button className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-3 py-1.5 rounded-md" onClick={() => lock()}>Lock</button>
        {gate && <button className="text-xs text-amber-300 border border-amber-700 rounded-md px-2 py-1" onClick={lockAnyway}>Lock anyway</button>}
        {err && <span className="text-xs text-red-400">{err}</span>}
      </div>
      {gate && (
        <div className="text-sm text-amber-300 border border-amber-700 rounded-md p-3 space-y-1">
          <div className="font-medium">This month does not tie yet:</div>
          {gate.problems.map((p, i) => <div key={i}>{p.accountName}: {p.status.replace('_', ' ')}{p.unexplainedCents ? `, ${(p.unexplainedCents / 100).toFixed(2)} unexplained` : ''}{p.openRows ? `, ${p.openRows} open row${p.openRows === 1 ? '' : 's'}` : ''}</div>)}
          {(gate.shortfalls ?? []).map(x => <div key={x.txnId}>Deposit of {x.postedDate} is {(x.shortCents / 100).toFixed(2)} short; classify it on the Bank feed Shortfalls tab</div>)}
          <div className="text-xs text-gray-400">Fix it on the Reconcile tab, or lock anyway with a reason.</div>
        </div>
      )}
      <Table head={['Locked month', '']} rows={locks.map(l => [l.month, <button key="u" className="text-xs text-red-400" onClick={() => unlock(l.month)}>Unlock</button>])} />
    </BooksShell>
  );
}
