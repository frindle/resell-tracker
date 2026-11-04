'use client';

// Paste an iCloud photo link (Photos > Share > Copy iCloud Link, or a Shared
// Album's public link); the server lists the photos and then pulls them in
// one request per photo, so a big batch never hits a proxy timeout.
import Link from 'next/link';
import { useState } from 'react';

type Item = { key: string; name: string; takenAt: string | null; downloadUrl: string };
type Row = Item & { state: 'waiting' | 'working' | 'uploaded' | 'duplicate' | 'error'; error?: string };

export default function IcloudImport() {
  const [link, setLink] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const set = (i: number, patch: Partial<Row>) => setRows(prev => prev.map((r, j) => j === i ? { ...r, ...patch } : r));

  async function fetchOne(i: number, item: Item) {
    set(i, { state: 'working', error: undefined });
    try {
      const res = await fetch('/api/orders/attachments/icloud/fetch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) set(i, { state: 'error', error: body.error ?? `HTTP ${res.status}` });
      else set(i, { state: body.status === 'duplicate' ? 'duplicate' : 'uploaded' });
    } catch (e) {
      set(i, { state: 'error', error: String(e) });
    }
  }

  async function run() {
    setError(''); setRows([]); setBusy(true);
    try {
      const res = await fetch('/api/orders/attachments/icloud/list', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ link }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.error ?? `HTTP ${res.status}`); return; }
      const items: Item[] = body.items ?? [];
      if (!items.length) { setError('No photos found behind that link.'); return; }
      setRows(items.map(it => ({ ...it, state: 'waiting' })));
      for (let i = 0; i < items.length; i++) await fetchOne(i, items[i]);
    } finally {
      setBusy(false);
    }
  }

  async function retryFailed() {
    setBusy(true);
    for (let i = 0; i < rows.length; i++) if (rows[i].state === 'error') await fetchOne(i, rows[i]);
    setBusy(false);
  }

  const count = (s: Row['state']) => rows.filter(r => r.state === s).length;

  return (
    <div className="rounded-lg border border-gray-800 p-4 space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-gray-200">Import from an iCloud link</h2>
        <p className="text-xs text-gray-400 mt-1">
          In Photos, select the pictures, tap Share, then <b>Copy iCloud Link</b>, and paste it here. A Shared Album&apos;s public
          link works too. The tracker downloads the full-size photos itself, so nothing uploads from your phone.
          Anyone with the link can see the photos until it expires; you can stop sharing once the import finishes.
        </p>
      </div>
      <div className="flex gap-2">
        <input value={link} onChange={e => setLink(e.target.value)} placeholder="https://share.icloud.com/photos/…"
          autoComplete="off" className="flex-1 bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-sm" />
        <button onClick={run} disabled={busy || !link.trim()}
          className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm">
          {busy ? 'Importing…' : 'Import'}
        </button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {rows.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs text-gray-400">
            {count('uploaded')} imported, {count('duplicate')} already here, {count('error')} failed, {rows.length - count('uploaded') - count('duplicate') - count('error')} to go, of {rows.length}.
            {' '}{count('uploaded') > 0 && !busy && <Link href="/orders/sort-assign" className="text-blue-400 hover:underline">Sort them onto orders</Link>}
          </p>
          {!busy && count('error') > 0 && (
            <button onClick={retryFailed} className="text-xs bg-red-900/30 hover:bg-red-900/50 border border-red-800 text-red-300 px-3 py-1.5 rounded-md">
              Retry {count('error')} failed
            </button>
          )}
          <div className="max-h-64 overflow-y-auto space-y-1">
            {rows.map((r, i) => (
              <div key={r.key} className="flex items-center gap-2 text-xs">
                <span className={r.state === 'uploaded' ? 'text-green-400' : r.state === 'error' ? 'text-red-400' : 'text-gray-500'}>
                  {r.state === 'uploaded' ? '✓' : r.state === 'duplicate' ? '=' : r.state === 'error' ? '✕' : r.state === 'working' ? '↓' : '·'}
                </span>
                <span className="text-gray-300 truncate max-w-[260px]">{r.name}</span>
                {r.state === 'duplicate' && <span className="text-gray-500">already here, skipped</span>}
                {r.state === 'error' && <span className="text-red-400 truncate">{r.error}</span>}
                {r.state === 'error' && !busy && <button onClick={() => fetchOne(i, r)} className="text-blue-400 underline shrink-0">Retry</button>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
