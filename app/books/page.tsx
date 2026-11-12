'use client';

import { useCallback, useEffect, useState } from 'react';
import { BooksShell, Off, Table, api, money } from './ui';

type Status = { enabled: boolean; goLive: string; tallyConfigured: boolean };
type Trial = { rows: { accountId: number; code: string; name: string; type: string; balanceCents: number }[]; totalCents: number };
type Pnl = { month: string; business: string; incomeCents: number; cogsCents: number; expenseCents: number; netCents: number }[];
type Entry = { id: number; date: string; memo: string; source: string; reversedAt: string | null; lines: { id: number; amountCents: number; account: { code: string; name: string } }[] };
type Tally = { configured: boolean; months: { month: string; postedEntryId: number | null; withdrawableCents: number | null }[] };

export default function BooksPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [trial, setTrial] = useState<Trial | null>(null);
  const [pnl, setPnl] = useState<Pnl>([]);
  const [journal, setJournal] = useState<Entry[]>([]);
  const [tally, setTally] = useState<Tally | null>(null);
  const [msg, setMsg] = useState('');
  const [goLive, setGoLive] = useState('');

  const load = useCallback(async () => {
    const s = await api<Status>('/api/books/status');
    setStatus(s.data);
    setGoLive(s.data.goLive ?? '');
    if (!s.data.enabled) return;
    const [r, j, t] = await Promise.all([api<{ trial: Trial; pnl: Pnl }>('/api/books/report'), api<Entry[]>('/api/books/journal?limit=50'), api<Tally>('/api/books/tally')]);
    if (r.ok) { setTrial(r.data.trial); setPnl(r.data.pnl); }
    if (j.ok) setJournal(j.data as unknown as Entry[]);
    if (t.ok) setTally(t.data);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function act(url: string, label: string) {
    setMsg(`${label}...`);
    const r = await api<Record<string, unknown>>(url, 'POST');
    setMsg(r.ok ? `${label}: ${JSON.stringify(r.data)}` : `${label} failed: ${r.data.error}`);
    load();
  }
  async function toggle(enabled: boolean) {
    const r = await api('/api/books/status', 'POST', { enabled, goLive });
    setMsg(r.ok ? '' : r.data.error ?? 'failed');
    load();
  }

  if (!status) return <BooksShell title="Books"><div className="text-gray-500 text-sm">Loading...</div></BooksShell>;
  return (
    <BooksShell title="Books">
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label className="text-xs text-gray-400 space-y-1"><span>Go-live date</span>
          <input className="input" value={goLive} onChange={e => setGoLive(e.target.value)} placeholder="YYYY-MM-DD" /></label>
        <button className="bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-md" onClick={() => toggle(!status.enabled)}>{status.enabled ? 'Turn books off' : 'Turn books on'}</button>
        {status.enabled && <button className="border border-gray-600 text-gray-200 px-3 py-1.5 rounded-md" onClick={() => act('/api/books/reconcile', 'Reconcile')}>Reconcile now</button>}
        {status.enabled && status.tallyConfigured && <button className="border border-gray-600 text-gray-200 px-3 py-1.5 rounded-md" onClick={() => act('/api/books/tally', 'Darkbloom tally sync')}>Sync Darkbloom tally</button>}
      </div>
      {msg && <div className="text-xs text-gray-400 break-all">{msg}</div>}
      {!status.enabled ? <Off /> : (
        <>
          <section className="space-y-2">
            <h2 className="text-sm font-medium text-gray-300">Profit and loss by month</h2>
            <Table head={['Month', 'Business', 'Income', 'COGS', 'Expenses', 'Net']} rows={pnl.map(p => [p.month, p.business, money(p.incomeCents), money(p.cogsCents), money(p.expenseCents), money(p.netCents)])} />
          </section>
          <section className="space-y-2">
            <h2 className="text-sm font-medium text-gray-300">Trial balance {trial && trial.totalCents !== 0 && <span className="text-red-400">(does not sum to zero: {money(trial.totalCents)})</span>}</h2>
            <Table head={['Code', 'Account', 'Type', 'Balance (debit +, credit -)']} rows={(trial?.rows ?? []).map(r => [r.code, r.name, r.type, money(r.balanceCents)])} />
          </section>
          {tally && (
            <section className="space-y-2">
              <h2 className="text-sm font-medium text-gray-300">Darkbloom tally {tally.configured ? '' : '(BLOOM_LEDGER_URL not set, disabled)'}</h2>
              <Table head={['Month', 'Posted entry', 'Tally withdrawable balance']} rows={tally.months.map(m => [m.month, m.postedEntryId ? `#${m.postedEntryId}` : '-', money(m.withdrawableCents)])} />
            </section>
          )}
          <section className="space-y-2">
            <h2 className="text-sm font-medium text-gray-300">Recent journal entries</h2>
            <Table head={['#', 'Date', 'Source', 'Memo', 'Lines']} rows={journal.map(e => [
              e.id, e.date, e.source, <span key="m" className={e.reversedAt ? 'line-through text-gray-500' : ''}>{e.memo}</span>,
              <div key="l" className="text-xs text-gray-400 space-y-0.5">{e.lines.map(l => <div key={l.id}>{l.account.code} {l.account.name}: {money(l.amountCents)}</div>)}</div>,
            ])} />
          </section>
        </>
      )}
    </BooksShell>
  );
}
