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
  async function lock() {
    const r = await api('/api/books/locks', 'POST', { month }); setErr(r.ok ? '' : r.data.error ?? 'failed'); if (r.ok) setMonth(''); load();
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
        <button className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-3 py-1.5 rounded-md" onClick={lock}>Lock</button>
        {err && <span className="text-xs text-red-400">{err}</span>}
      </div>
      <Table head={['Locked month', '']} rows={locks.map(l => [l.month, <button key="u" className="text-xs text-red-400" onClick={() => unlock(l.month)}>Unlock</button>])} />
    </BooksShell>
  );
}
