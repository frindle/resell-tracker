'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

type Entry = {
  id: number; createdAt: string; pageKind: string; orderNumber: string; action: string; applied: boolean;
  changes: { field: string; from: unknown; to: unknown }[];
  discrepancies: { field: string; stored: unknown; page: unknown }[];
};

const fmt = (v: unknown) => (v === null || v === undefined || v === '' ? '(blank)' : String(v));

export default function AmazonCapturePage() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [apply, setApply] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const r = await fetch('/api/extension/amazon-log');
    if (r.ok) { const j = await r.json(); setEntries(j.entries); setApply(j.apply); }
  };
  useEffect(() => { load(); }, []);

  const toggle = async () => {
    setBusy(true);
    await fetch('/api/extension/amazon-log', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apply: !apply }) });
    await load(); setBusy(false);
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-xl font-semibold">Amazon capture log</h1>
        <div className="flex gap-3 text-sm items-center">
          <a className="underline" href="/api/extension/amazon-log?format=csv">Export CSV</a>
          <a className="underline" href="/api/extension/amazon-log?format=json">Export JSON</a>
          <Link className="underline" href="/sync-history">Sync history</Link>
        </div>
      </div>
      <div className="rounded border p-3 text-sm flex items-center justify-between gap-3">
        <span>
          Mode: <b>{apply ? 'Apply (captured pages change orders)' : 'Compare only (nothing is written except this log)'}</b>
        </span>
        <button disabled={busy} onClick={toggle} className="rounded border px-3 py-1">
          {apply ? 'Switch to compare only' : 'Turn apply on'}
        </button>
      </div>
      {entries.length === 0 && <p className="text-sm opacity-70">Nothing logged yet. Browse your Amazon orders with the extension installed.</p>}
      <div className="space-y-2">
        {entries.map(e => (
          <div key={e.id} className="rounded border p-3 text-sm">
            <div className="flex justify-between gap-2">
              <span><b>{e.orderNumber}</b> &middot; {e.pageKind} &middot; {e.action}{e.applied ? ' (applied)' : ' (proposed)'}</span>
              <span className="opacity-60">{new Date(e.createdAt).toLocaleString()}</span>
            </div>
            {e.changes.map((c, i) => <div key={i}>{e.applied ? 'Filled' : 'Would fill'} {c.field}: {fmt(c.from)} &rarr; {fmt(c.to)}</div>)}
            {e.discrepancies.map((d, i) => <div key={i} className="text-amber-600">Differs {d.field}: stored {fmt(d.stored)} vs page {fmt(d.page)}</div>)}
          </div>
        ))}
      </div>
    </div>
  );
}
