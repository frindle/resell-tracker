'use client';

import { useEffect, useState } from 'react';
import { parseCostcoDeliveryLink } from '@/lib/egiftLinkParse';

type Status = { hasLink: boolean; masked: string | null; updatedAt: string | null };

// The delivery link is a secret: the page only ever holds the masked value
// until the user clicks Reveal/Copy, and revealed text is dropped again on hide.
export default function EgiftLink({ orderId }: { orderId: number }) {
  const url = `/api/orders/${orderId}/egift-link`;
  const [status, setStatus] = useState<Status | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function load() {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (r.ok) setStatus(await r.json());
    } catch {
      /* leave status unset */
    }
  }

  useEffect(() => {
    fetch(`/api/orders/${orderId}/egift-link`, { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(s => s && setStatus(s))
      .catch(() => {});
  }, [orderId]);

  async function fetchLink(): Promise<string | null> {
    const r = await fetch(`${url}?reveal=1`, { cache: 'no-store' });
    if (!r.ok) {
      setError('Could not load link');
      return null;
    }
    const body = await r.json();
    return typeof body.link === 'string' ? body.link : null;
  }

  async function reveal() {
    if (revealed) {
      setRevealed(null);
      return;
    }
    setError(null);
    setRevealed(await fetchLink());
  }

  async function copy() {
    setError(null);
    const link = revealed ?? (await fetchLink());
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Copy failed');
    }
  }

  async function save() {
    setError(null);
    const parsed = parseCostcoDeliveryLink(input.trim());
    if (!parsed.ok) {
      setError('Not a valid Costco eGift delivery link');
      return;
    }
    setBusy(true);
    try {
      const r = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ link: parsed.normalized }),
      });
      if (!r.ok) {
        setError(r.status === 409 ? 'Order is locked' : 'Save failed');
        return;
      }
      setInput('');
      setRevealed(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setError(null);
    setBusy(true);
    try {
      const r = await fetch(url, { method: 'DELETE' });
      if (!r.ok) {
        setError(r.status === 409 ? 'Order is locked' : 'Remove failed');
        return;
      }
      setRevealed(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  const btn = 'text-xs px-2 py-1 rounded border border-gray-700 text-gray-300 hover:bg-gray-800 disabled:opacity-50';

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-gray-300">Costco eGift link</h3>
      {status?.hasLink && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-gray-400">{status.masked}</span>
          <button type="button" className={btn} onClick={reveal}>{revealed ? 'Hide' : 'Reveal'}</button>
          <button type="button" className={btn} onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
          <button type="button" className={btn} disabled={busy} onClick={remove}>Remove</button>
        </div>
      )}
      {revealed && <p className="text-xs text-gray-400 break-all select-all">{revealed}</p>}
      <div className="flex gap-2">
        <input
          type="url"
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="https://www.memberedelivery.com/?login=..."
          autoComplete="off"
          className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm"
        />
        <button type="button" className={btn} disabled={busy || !input.trim()} onClick={save}>
          {status?.hasLink ? 'Replace' : 'Save'}
        </button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
