'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

type Entry = {
  id: number; createdAt: string; orderNumber: string | null; trackingNumber: string;
  decision: 'exact' | 'manual'; reason: string | null; message: string;
  wouldSubmit: { reservationId: number; qty: number; trackingNumber: string }[]; caveats: string[];
};

export default function BfmrDryRunPage() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [packages, setPackages] = useState(0);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<'all' | 'exact' | 'manual'>('all');

  const load = async () => {
    const r = await fetch('/api/bfmr/package-dry-run');
    if (r.ok) { const j = await r.json(); setEntries(j.entries); setPackages(j.packages); }
  };
  useEffect(() => { load(); }, []);

  const rerun = async () => {
    setBusy(true);
    await fetch('/api/bfmr/package-dry-run', { method: 'POST' });
    await load(); setBusy(false);
  };

  const shown = entries.filter(e => filter === 'all' || e.decision === filter);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-xl font-semibold">BFMR tracking dry run</h1>
        <Link className="underline text-sm" href="/amazon-capture">Amazon capture log</Link>
      </div>
      <div className="rounded border p-3 text-sm space-y-2">
        <p><b>Nothing is sent to BFMR.</b> This lists what the tracker would submit for each captured Amazon package, and why the rest need a person. Submit tracking by hand from the order page as before.</p>
        <p className="opacity-70">{packages} package(s) captured so far. A package is &quot;would submit&quot; only when its items and quantities match the BFMR reservation line(s) to the unit.</p>
        <div className="flex gap-2 items-center">
          <button disabled={busy} onClick={rerun} className="rounded border px-3 py-1">Re-check captured packages</button>
          {(['all', 'exact', 'manual'] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)} className={`rounded border px-3 py-1 ${filter === f ? 'font-semibold' : ''}`}>
              {f === 'all' ? 'All' : f === 'exact' ? 'Would submit' : 'Needs a person'}
            </button>
          ))}
        </div>
      </div>
      {shown.length === 0 && <p className="text-sm opacity-70">Nothing logged yet. Open an Amazon order detail or tracking page with the extension installed, then re-check.</p>}
      <div className="space-y-2">
        {shown.map(e => (
          <div key={e.id} className="rounded border p-3 text-sm">
            <div className="flex justify-between gap-2 flex-wrap">
              <span><b>{e.orderNumber ?? '(no order number)'}</b> &middot; {e.trackingNumber} &middot; {e.decision === 'exact' ? 'would submit' : `needs a person (${e.reason})`}</span>
              <span className="opacity-60">{new Date(e.createdAt).toLocaleString()}</span>
            </div>
            <div>{e.message}</div>
            {e.wouldSubmit.map((w, i) => <div key={i}>Would send: reservation #{w.reservationId}, qty {w.qty}, tracking {w.trackingNumber}</div>)}
            {e.caveats.map((c, i) => <div key={i} className="text-amber-600">Check: {c}</div>)}
          </div>
        ))}
      </div>
    </div>
  );
}
