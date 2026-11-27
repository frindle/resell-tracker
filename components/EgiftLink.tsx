'use client';

import { useEffect, useState } from 'react';
import { parseCostcoDeliveryLink } from '@/lib/egiftLinkParse';

import { normalizeEgiftEmail } from '@/lib/egiftEmail';
import { egiftScrapeBlocker, egiftScrapeCommand } from '@/lib/egiftScrape';

type Status = { hasLink: boolean; masked: string | null; updatedAt: string | null };
type EmailStatus = {
  hasOrderEmail: boolean;
  masked: string | null;
  source: 'order' | 'default' | null;
  hasDefault: boolean;
  defaultMasked: string | null;
};

// The delivery link is a secret: the page only ever holds the masked value
// until the user clicks Reveal/Copy, and revealed text is dropped again on hide.
export default function EgiftLink({ orderId }: { orderId: number }) {
  const url = `/api/orders/${orderId}/egift-link`;
  const [status, setStatus] = useState<Status | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const emailUrl = `/api/orders/${orderId}/egift-email`;
  const [emailStatus, setEmailStatus] = useState<EmailStatus | null>(null);
  const [emailInput, setEmailInput] = useState('');
  const [asDefault, setAsDefault] = useState(false);

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
    fetch(`/api/orders/${orderId}/egift-email`, { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(s => s && setEmailStatus(s))
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

  async function saveEmail() {
    setError(null);
    if (!normalizeEgiftEmail(emailInput)) {
      setError('Not a valid email address');
      return;
    }
    setBusy(true);
    try {
      const r = await fetch(emailUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailInput.trim(), saveAsDefault: asDefault }),
      });
      if (!r.ok) {
        setError(r.status === 409 ? 'Order is locked' : 'Save failed');
        return;
      }
      setEmailStatus(await r.json());
      setEmailInput('');
      setAsDefault(false);
    } finally {
      setBusy(false);
    }
  }

  async function removeEmail(scopeDefault: boolean) {
    setError(null);
    setBusy(true);
    try {
      const r = await fetch(scopeDefault ? `${emailUrl}?scope=default` : emailUrl, { method: 'DELETE' });
      if (!r.ok) {
        setError(r.status === 409 ? 'Order is locked' : 'Remove failed');
        return;
      }
      setEmailStatus(await r.json());
    } finally {
      setBusy(false);
    }
  }

  // The delivery site is read in a real browser, so this queues a command for
  // the browser extension. It is refused here, with the reason, when the link
  // or the delivery email is missing.
  const blocker = egiftScrapeBlocker({ hasLink: !!status?.hasLink, hasEmail: !!emailStatus?.masked });
  async function fetchCards() {
    setError(null);
    setNote(null);
    if (blocker) { setError(blocker); return; }
    setBusy(true);
    try {
      const r = await fetch('/api/extension/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(egiftScrapeCommand(orderId)),
      });
      setNote(r.ok
        ? 'Queued for the browser extension. It must be open and signed in; the cards appear in Gift cards when it finishes (see Sync Status).'
        : 'Could not queue the fetch');
    } catch {
      setNote('Could not queue the fetch');
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
      <div className="pt-2 space-y-2">
        <h4 className="text-xs font-semibold text-gray-400">Delivery email</h4>
        {emailStatus?.masked && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-gray-400">{emailStatus.masked}</span>
            <span className="text-xs text-gray-500">
              {emailStatus.source === 'default' ? '(your default)' : '(this order)'}
            </span>
            {emailStatus.hasOrderEmail && (
              <button type="button" className={btn} disabled={busy} onClick={() => removeEmail(false)}>Remove</button>
            )}
          </div>
        )}
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="email"
            value={emailInput}
            onChange={e => setEmailInput(e.target.value)}
            placeholder="Address the eGift was sent to"
            autoComplete="off"
            className="flex-1 min-w-0 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm"
          />
          <button type="button" className={btn} disabled={busy || !emailInput.trim()} onClick={saveEmail}>
            {emailStatus?.hasOrderEmail ? 'Replace' : 'Save'}
          </button>
        </div>
        <label className="flex items-center gap-2 text-xs text-gray-400">
          <input type="checkbox" checked={asDefault} onChange={e => setAsDefault(e.target.checked)} />
          Also use as my default for other orders
        </label>
        {emailStatus?.hasDefault && (
          <p className="text-xs text-gray-500">
            Default: {emailStatus.defaultMasked}{' '}
            <button type="button" className="underline" disabled={busy} onClick={() => removeEmail(true)}>
              clear default
            </button>
          </p>
        )}
      </div>
      <div className="pt-2 space-y-1">
        <button type="button" className={btn} disabled={busy || !!blocker} onClick={fetchCards}>
          Fetch cards from link
        </button>
        {blocker && <p className="text-xs text-gray-500">{blocker}</p>}
        {note && <p className="text-xs text-gray-400">{note}</p>}
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
