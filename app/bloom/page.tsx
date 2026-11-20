'use client';

import { useCallback, useEffect, useState } from 'react';

type Row = { month: string; grossCents: number; otherIncomeCents: number; feesCents: number; costsCents: number; netCents: number; updatedAt: string };

const money = (c: number) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export default function BloomPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch('/api/bloom/invoices');
    if (r.ok) {
      const d = await r.json();
      setRows(d.invoices); setConfigured(d.configured);
    }
    setLoading(false);
  }, []);
  useEffect(() => { load().catch(() => setLoading(false)); }, [load]);

  async function sync() {
    setBusy(true); setMsg('');
    try {
      const r = await fetch('/api/bloom/invoices/sync', { method: 'POST' });
      const d = await r.json();
      if (!r.ok) setMsg(d.error ?? 'Sync failed');
      else setMsg(`Checked ${d.checked} month${d.checked === 1 ? '' : 's'}: ${d.created} new, ${d.updated} updated, ${d.unchanged} unchanged${d.skippedNonFinal ? `, ${d.skippedNonFinal} not final yet` : ''}.${d.errors?.length ? ' Errors: ' + d.errors.join('; ') : ''}`);
      await load();
    } catch { setMsg('Sync failed'); } finally { setBusy(false); }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Bloom Ledger invoices</h1>
        <p className="text-gray-400 text-sm mt-1">One mock invoice per month of Darkbloom earnings, counted as side-hustle income in Analytics. They arrive from Bloom Ledger by themselves each day (and post to Books at the same time); on the 1st the month that just ended is added once Bloom Ledger calls it final. Net = earnings minus Darkbloom fees, power, depreciation and any lease.</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={sync} disabled={busy || !configured}
          className="text-sm px-3 py-1.5 rounded-md bg-blue-600 text-white disabled:opacity-50">{busy ? 'Syncing…' : 'Sync from Bloom Ledger'}</button>
        {!configured && <span className="text-xs text-amber-400">BLOOM_LEDGER_URL is not set on this server.</span>}
        {msg && <span className="text-xs text-gray-400" role="status">{msg}</span>}
      </div>
      {loading && <div className="text-gray-500 text-sm">Loading…</div>}
      {!loading && rows.length === 0 && <div className="text-gray-500 text-sm">No invoices yet.</div>}
      {rows.length > 0 && (
        <div className="rounded-lg border border-gray-800 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-900 text-gray-400 text-xs uppercase">
              <tr>
                <th className="px-4 py-2 text-left">Month</th>
                <th className="px-4 py-2 text-right">Earnings</th>
                <th className="px-4 py-2 text-right">Costs</th>
                <th className="px-4 py-2 text-right">Net</th>
                <th className="px-4 py-2 text-left"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {rows.map(r => (
                <tr key={r.month} className="hover:bg-gray-900/40">
                  <td className="px-4 py-2 text-gray-300">{r.month}</td>
                  <td className="px-4 py-2 text-right text-gray-300">{money(r.grossCents + r.otherIncomeCents)}</td>
                  <td className="px-4 py-2 text-right text-gray-300">{money(r.costsCents + r.feesCents)}</td>
                  <td className={`px-4 py-2 text-right font-medium ${r.netCents >= 0 ? 'text-green-400' : 'text-red-400'}`}>{money(r.netCents)}</td>
                  <td className="px-4 py-2"><a className="text-blue-400 hover:underline" href={`/bloom/${r.month}`}>View invoice</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
