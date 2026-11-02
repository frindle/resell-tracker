'use client';

import { useEffect, useState } from 'react';
import { parseMgcpLink, splitMgcpLinks } from '@/lib/mgcpLinkParse';

type Link = { id: number; masked: string; status: string; giftCardId: number | null };

const STATUS_TEXT: Record<string, string> = {
  pending: 'Waiting to scrape',
  captured: 'Captured',
  failed: 'Failed — will retry on next scrape',
};

// MGCP card links are secrets: the browser only ever sees a fixed mask, never
// the link itself (only the sidecar can read them back). Each link is one card.
export default function MgcpLinks({ orderId }: { orderId: number }) {
  const url = `/api/orders/${orderId}/mgcp-links`;
  const [links, setLinks] = useState<Link[]>([]);
  const [input, setInput] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (r.ok) setLinks((await r.json()).links ?? []);
    } catch { /* keep current list */ }
  }

  useEffect(() => { void load(); }, [orderId]); // eslint-disable-line react-hooks/exhaustive-deps

  const candidates = splitMgcpLinks(input);
  const invalidCount = candidates.filter(c => !parseMgcpLink(c).ok).length;
  const open = links.filter(l => l.status !== 'captured').length;

  async function add() {
    setError(null); setMsg(null);
    if (candidates.length === 0) return;
    if (invalidCount > 0) { setError(`${invalidCount} entr${invalidCount === 1 ? 'y is' : 'ies are'} not valid MGCP card links`); return; }
    setBusy(true);
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ links: candidates }) });
      if (!r.ok) { setError(r.status === 409 ? 'Order is locked' : 'Save failed'); return; }
      const b = await r.json();
      setMsg(`Added ${b.added}${b.duplicates ? `, ${b.duplicates} already saved` : ''}`);
      setInput('');
      await load();
    } finally { setBusy(false); }
  }

  async function remove(id: number) {
    setError(null);
    setBusy(true);
    try {
      const r = await fetch(`${url}?linkId=${id}`, { method: 'DELETE' });
      if (!r.ok) { setError(r.status === 409 ? 'Order is locked' : 'Remove failed'); return; }
      await load();
    } finally { setBusy(false); }
  }

  async function scrape() {
    setError(null); setMsg(null);
    setBusy(true);
    try {
      const r = await fetch('/api/extension/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'SCRAPE_MGCP', targetBrowser: 'sidecar', payload: { orderId } }),
      });
      setMsg(r.ok
        ? 'Scrape queued. If a captcha appears, complete it in the sidecar browser (VNC) — the scrape resumes on its own.'
        : 'Could not queue the scrape');
    } finally { setBusy(false); }
  }

  const btn = 'text-xs px-2 py-1 rounded border border-gray-700 text-gray-300 hover:bg-gray-800 disabled:opacity-50';

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-gray-300">MGCP card links</h3>
      {links.length > 0 && (
        <ul className="space-y-1">
          {links.map((l, i) => (
            <li key={l.id} className="flex flex-wrap items-center gap-2 text-sm text-gray-400">
              <span>#{i + 1} {l.masked}</span>
              <span className={l.status === 'failed' ? 'text-red-400' : l.status === 'captured' ? 'text-green-400' : ''}>
                {STATUS_TEXT[l.status] ?? l.status}
              </span>
              {l.status !== 'captured' && (
                <button type="button" className={btn} disabled={busy} onClick={() => remove(l.id)}>Remove</button>
              )}
            </li>
          ))}
        </ul>
      )}
      <textarea
        value={input}
        onChange={e => setInput(e.target.value)}
        rows={3}
        placeholder={'One link per line\nhttps://www.mygiftcardsplus.com/card?c=...'}
        autoComplete="off"
        spellCheck={false}
        className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm"
      />
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btn} disabled={busy || candidates.length === 0} onClick={add}>
          Add {candidates.length > 1 ? `${candidates.length} links` : 'link'}
        </button>
        <button type="button" className={btn} disabled={busy || open === 0} onClick={scrape}>
          Scrape {open} card{open === 1 ? '' : 's'}
        </button>
      </div>
      {msg && <p className="text-xs text-gray-400">{msg}</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
