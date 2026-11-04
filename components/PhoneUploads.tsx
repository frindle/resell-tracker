'use client';

// Settings section: upload keys for the iOS Shortcut (POST /api/upload/photo)
// and the photo auto-attach switch.
import { useEffect, useState } from 'react';

type Token = { id: number; name: string; createdAt: string; lastUsedAt: string | null };

export default function PhoneUploads() {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [name, setName] = useState('iPhone');
  const [fresh, setFresh] = useState<string | null>(null);
  const [ocrEnabled, setOcrEnabled] = useState(false);
  const [autoAssign, setAutoAssign] = useState(false);
  const [error, setError] = useState('');
  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  async function load() {
    const [t, s] = await Promise.all([
      fetch('/api/upload-tokens').then(r => r.ok ? r.json() : { tokens: [] }),
      fetch('/api/photo-ocr/settings').then(r => r.ok ? r.json() : null),
    ]);
    setTokens(t.tokens ?? []);
    if (s) { setOcrEnabled(!!s.ocrEnabled); setAutoAssign(!!s.autoAssign); }
  }
  useEffect(() => { load(); }, []);

  async function create() {
    setError('');
    const res = await fetch('/api/upload-tokens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() || 'Phone' }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { setError(body.error ?? `HTTP ${res.status}`); return; }
    setFresh(body.token);
    await load();
  }

  async function revoke(id: number) {
    await fetch(`/api/upload-tokens/${id}`, { method: 'DELETE' });
    await load();
  }

  async function toggleAuto(next: boolean) {
    const res = await fetch('/api/photo-ocr/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoAssign: next }) });
    if (res.ok) setAutoAssign(next);
  }

  return (
    <section className="rounded-lg border border-gray-800 p-6 space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Phone Uploads</h2>
        <p className="text-gray-400 text-sm mt-1">
          Send gift card and receipt photos from an iOS Shortcut. They land in Sort &amp; Assign, where they are read and matched to orders.
        </p>
      </div>

      {!ocrEnabled && (
        <p className="text-xs text-amber-400">Photo reading is switched off on this server (GIFTCARD_OCR_ENABLED=false). Uploads still work; matching starts once it is back on.</p>
      )}

      <label className="flex items-center gap-2 text-sm text-gray-300">
        <input type="checkbox" checked={autoAssign} onChange={e => toggleAuto(e.target.checked)} />
        Attach photos automatically when the card number or order number matches exactly one order
      </label>

      <div className="flex gap-2">
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Key name"
          className="flex-1 bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-sm" />
        <button onClick={create} className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white text-sm">Create upload key</button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}

      {fresh && (
        <div className="rounded border border-green-800 bg-green-950/40 p-3 space-y-1">
          <p className="text-xs text-green-300">Copy this key now. It won&apos;t be shown again.</p>
          <code className="block text-sm break-all select-all text-green-100">{fresh}</code>
        </div>
      )}

      {tokens.length > 0 && (
        <ul className="divide-y divide-gray-800 text-sm">
          {tokens.map(t => (
            <li key={t.id} className="flex items-center justify-between py-2">
              <span className="text-gray-200">{t.name}</span>
              <span className="flex items-center gap-3 text-xs text-gray-500">
                {t.lastUsedAt ? `Last used ${new Date(t.lastUsedAt).toLocaleString()}` : 'Never used'}
                <button onClick={() => revoke(t.id)} className="text-red-400 hover:text-red-300">Revoke</button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <details className="text-sm text-gray-400">
        <summary className="cursor-pointer text-gray-300">Set up the Shortcut</summary>
        <ol className="list-decimal list-inside space-y-1 mt-2">
          <li>New Shortcut, turn on &quot;Show in Share Sheet&quot; and accept Images.</li>
          <li>Add <b>Repeat with Each</b> over the Shortcut Input.</li>
          <li>Inside it, add <b>Get Contents of URL</b>: <code className="text-gray-300">{origin}/api/upload/photo</code>, Method POST.</li>
          <li>Headers: <code className="text-gray-300">Authorization</code> = <code className="text-gray-300">Bearer &lt;your key&gt;</code>. Optional: <code className="text-gray-300">X-Captured-At</code> = the image&apos;s Creation Date (helps match receipts with no date printed).</li>
          <li>Request Body: <b>File</b>, set to Repeat Item.</li>
        </ol>
        <p className="mt-2 text-xs text-gray-500">If the site sits behind Cloudflare Access, also add its service-token headers (CF-Access-Client-Id / CF-Access-Client-Secret).</p>
      </details>
    </section>
  );
}
