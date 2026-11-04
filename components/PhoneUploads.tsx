'use client';

// Settings section: upload keys for the iOS Shortcut (POST /api/upload/photo)
// and the photo auto-attach switch.
import { useEffect, useState } from 'react';

type Token = { id: number; name: string; createdAt: string; lastUsedAt: string | null; uploads: number };

export default function PhoneUploads() {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [name, setName] = useState('iPhone');
  const [fresh, setFresh] = useState<string | null>(null);
  // Cloudflare service token: saved on the server (secret never sent back);
  // a new key's response carries it once so it can go in the setup code.
  type CfStatus = { configured: boolean; source?: 'env' | 'saved'; clientId?: string; canEdit?: boolean };
  const [cf, setCf] = useState<CfStatus>({ configured: false });
  const [freshCf, setFreshCf] = useState<{ clientId: string; clientSecret: string } | null>(null);
  const [cfId, setCfId] = useState('');
  const [cfSecret, setCfSecret] = useState('');
  const [cfEditing, setCfEditing] = useState(false);
  const [cfError, setCfError] = useState('');
  const [copied, setCopied] = useState(false);
  const [ocrEnabled, setOcrEnabled] = useState(false);
  const [autoAssign, setAutoAssign] = useState(false);
  const [error, setError] = useState('');
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  // "-" keeps every slot filled, so the Shortcut's Split Text always yields 4 items.
  // Base64 so it reads as one opaque code, not a URL someone copies just part of.
  // Every part is ASCII (origin, rtu_ key, CF id/secret), so btoa is safe.
  const setupCode = fresh ? btoa([origin, fresh, freshCf?.clientId || '-', freshCf?.clientSecret || '-'].join('|')) : '';

  async function load() {
    const [t, s, c] = await Promise.all([
      fetch('/api/upload-tokens').then(r => r.ok ? r.json() : { tokens: [] }),
      fetch('/api/photo-ocr/settings').then(r => r.ok ? r.json() : null),
      fetch('/api/upload-tokens/cloudflare').then(r => r.ok ? r.json() : null),
    ]);
    setTokens(t.tokens ?? []);
    if (c) setCf(c);
    if (s) { setOcrEnabled(!!s.ocrEnabled); setAutoAssign(!!s.autoAssign); }
  }
  useEffect(() => { load(); }, []);

  async function create() {
    setError('');
    const res = await fetch('/api/upload-tokens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() || 'Phone' }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { setError(body.error ?? `HTTP ${res.status}`); return; }
    setFresh(body.token);
    setFreshCf(body.cf ?? null);
    setCopied(false);
    await load();
  }

  async function saveCf() {
    setCfError('');
    const res = await fetch('/api/upload-tokens/cloudflare', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: cfId, clientSecret: cfSecret }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { setCfError(body.error ?? `HTTP ${res.status}`); return; }
    setCf(body);
    // A key made before saving still gets the token in its setup code.
    if (fresh) { setFreshCf({ clientId: cfId, clientSecret: cfSecret }); setCopied(false); }
    setCfId(''); setCfSecret(''); setCfEditing(false);
  }

  async function removeCf() {
    const res = await fetch('/api/upload-tokens/cloudflare', { method: 'DELETE' });
    if (res.ok) setCf(await res.json());
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

      <div className="rounded border border-gray-800 p-3 space-y-2">
        <p className="text-sm text-gray-300">Cloudflare token for uploads away from home</p>
        {cf.configured && !cfEditing ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
            <span>Saved: <code className="text-gray-300">{cf.clientId}</code>{cf.source === 'env' ? ' (from the server environment)' : ''}. New setup codes include it.</span>
            {cf.source === 'saved' && cf.canEdit && (<>
              <button onClick={() => setCfEditing(true)} className="px-2 py-0.5 rounded border border-gray-700 hover:bg-gray-800">Replace</button>
              <button onClick={removeCf} className="px-2 py-0.5 rounded border border-gray-700 hover:bg-gray-800">Remove</button>
            </>)}
          </div>
        ) : !cf.canEdit ? (
          <p className="text-xs text-gray-400">Not set up yet. The tracker owner adds it here; your setup codes include it after that.</p>
        ) : (
          <>
            <p className="text-xs text-gray-400">
              The service token from Cloudflare Zero Trust that lets the Shortcut past Access. Saved once for everyone on this tracker; the secret is never shown again.
            </p>
            <div className="flex flex-col sm:flex-row gap-2">
              <input value={cfId} onChange={e => setCfId(e.target.value.trim())} placeholder="CF Client ID (ends in .access)"
                autoComplete="off" className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs" />
              <input value={cfSecret} onChange={e => setCfSecret(e.target.value.trim())} placeholder="CF Client Secret" type="password"
                autoComplete="off" className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs" />
              <button onClick={saveCf} className="px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white text-xs">Save token</button>
              {cfEditing && <button onClick={() => { setCfEditing(false); setCfError(''); }} className="px-2 py-1 rounded border border-gray-700 text-xs">Cancel</button>}
            </div>
            {cfError && <p className="text-xs text-red-400">{cfError}</p>}
          </>
        )}
      </div>

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
          {!freshCf && (
            <p className="text-xs text-amber-400 pt-2">No Cloudflare token in this code, so it only works at home. Save the token below and the code updates.</p>
          )}
          <p className="text-xs text-green-300 pt-2">Setup code: tap Copy and paste the whole code when the Shortcut asks for it.</p>
          <div className="flex gap-2 items-start">
            <code className="flex-1 block text-xs break-all select-all text-green-100 bg-gray-900 rounded p-2">{setupCode}</code>
            <button
              onClick={async () => { await navigator.clipboard.writeText(setupCode); setCopied(true); }}
              className="px-2 py-1 rounded bg-green-700 hover:bg-green-600 text-white text-xs"
            >{copied ? 'Copied' : 'Copy'}</button>
          </div>
        </div>
      )}

      {tokens.length > 0 && (
        <ul className="divide-y divide-gray-800 text-sm">
          {tokens.map(t => (
            <li key={t.id} className="flex items-center justify-between py-2">
              <span className="text-gray-200">{t.name}</span>
              <span className="flex items-center gap-3 text-xs text-gray-500">
                {t.uploads} photo{t.uploads === 1 ? '' : 's'} · {t.lastUsedAt ? `last used ${new Date(t.lastUsedAt).toLocaleString()}` : 'never used'}
                <button onClick={() => revoke(t.id)} className="text-red-400 hover:text-red-300">Revoke</button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="text-sm text-gray-400 space-y-1">
        <a
          href="/shortcuts/Send%20to%20Tracker.shortcut"
          download="Send to Tracker.shortcut"
          className="inline-block px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white font-medium"
        >
          Get the iPhone Shortcut
        </a>
        <p>
          On the iPhone: save the Cloudflare token above (once), create an upload key, and tap <b>Copy</b> on the setup code (it only shows right after creating a key).
          Then tap this button, tap <b>Add Shortcut</b>, and paste the setup code when it asks.
          Then in Photos: select photos → Share → <b>Send to Tracker</b>. The notification lists each photo as uploaded, skipped (already sent) or failed.
        </p>
      </div>

      <details className="text-sm text-gray-400">
        <summary className="cursor-pointer text-gray-300">Or build it by hand (step by step)</summary>
        <div className="mt-3 space-y-4">
          <p>
            Do this on the iPhone, in the Shortcuts app. You need an upload key from above and, for use away from home (through Cloudflare) the service token&apos;s Client ID and Client Secret.
            Find an action by typing its name in the search bar at the bottom of the editor.
          </p>

          <ol className="list-decimal pl-5 space-y-3">
            <li>
              <b className="text-gray-200">Create it.</b> Open Shortcuts, tap <b>+</b> top right. Tap the name at the top, choose <b>Rename</b>, and call it <K>Send to Tracker</K>.
            </li>
            <li>
              <b className="text-gray-200">Make it take photos.</b> Tap the <b>ⓘ</b> button at the bottom and turn on <b>Show in Share Sheet</b>, then tap Done.
              A line appears at the top: &quot;Receive <i>Any</i> input from <i>Share Sheet</i>&quot;. Tap <i>Any</i>, tap <b>Clear</b>, then select only <b>Images</b>.
              On the &quot;If there&apos;s no input&quot; line, tap <i>Continue</i> and pick <b>Ask For → Photos</b> (lets you run it from the Shortcuts app too).
            </li>
            <li>
              <b className="text-gray-200">Loop over the photos.</b> Add <b>Repeat with Each</b>. It should read &quot;Repeat with each item in <i>Shortcut Input</i>&quot;.
              Every action below, up to step 8, goes <b>inside</b> the repeat (between Repeat and End Repeat).
            </li>
            <li>
              <b className="text-gray-200">Convert to JPEG.</b> Add <b>Convert Image</b>. Set it to &quot;Convert <i>Repeat Item</i> to <i>JPEG</i>&quot;. Leave Preserve Metadata on.
            </li>
            <li>
              <b className="text-gray-200">Send it.</b> Add <b>Get Contents of URL</b>. Tap the URL field and enter:
              <Code>{origin}/api/upload/photo</Code>
              Tap <b>Show More</b> (the arrow). Set <b>Method</b> to <b>POST</b>. Under <b>Headers</b>, tap <b>Add new header</b> once for each row:
              <table className="mt-2 mb-2 w-full text-xs border border-gray-700">
                <thead className="text-gray-300"><tr><th className="text-left p-1.5 border-b border-gray-700">Key</th><th className="text-left p-1.5 border-b border-gray-700">Text</th></tr></thead>
                <tbody>
                  <tr><td className="p-1.5 align-top"><K>Authorization</K></td><td className="p-1.5"><K>Bearer </K> then paste your upload key (one space after Bearer)</td></tr>
                    <tr><td className="p-1.5 align-top"><K>CF-Access-Client-Id</K></td><td className="p-1.5">the service token Client ID (ends in <K>.access</K>). Needed through Cloudflare; harmless at home.</td></tr>
                    <tr><td className="p-1.5 align-top"><K>CF-Access-Client-Secret</K></td><td className="p-1.5">the service token Client Secret</td></tr>
                  <tr><td className="p-1.5 align-top"><K>X-Photo-Id</K></td><td className="p-1.5">tap the field, insert the <b>Repeat Item</b> variable, tap it and pick <b>Name</b>. Type <K>-</K>. Insert <b>Repeat Item</b> again, pick <b>Date Taken</b>, and set Date Format to <b>ISO 8601</b>. This is how a re-sent photo is recognised and skipped.</td></tr>
                  <tr><td className="p-1.5 align-top"><K>X-Captured-At</K></td><td className="p-1.5"><b>Repeat Item</b> → <b>Date Taken</b>, ISO 8601. Used to match receipts with no printed date.</td></tr>
                </tbody>
              </table>
              Set <b>Request Body</b> to <b>Form</b>. Tap <b>Add new field</b>, choose <b>File</b>, set the key to <K>file</K> and the value to the <b>Converted Image</b> variable.
            </li>
            <li>
              <b className="text-gray-200">Read the answer.</b> Add <b>Get Dictionary Value</b>: &quot;Get <i>Value</i> for <K>summary</K> in <i>Contents of URL</i>&quot;.
              Each upload answers with a line like <K>IMG_1234.jpeg: uploaded</K>, <K>…: already uploaded, skipped</K> or <K>…: failed, …</K>.
            </li>
            <li>
              <b className="text-gray-200">Collect it.</b> Add <b>Add to Variable</b>: &quot;Add <i>Dictionary Value</i> to <K>Results</K>&quot; (type the name Results).
            </li>
            <li>
              <b className="text-gray-200">Report.</b> Below <b>End Repeat</b> (outside the loop), add <b>Combine Text</b>: &quot;Combine <i>Results</i> with <i>New Lines</i>&quot;.
              Then add <b>Show Notification</b> with <i>Combined Text</i> (or <b>Show Result</b> if you want it to stay on screen for a long batch).
            </li>
          </ol>

          <div>
            <b className="text-gray-200">Try it.</b> Tap ▶ in the editor and pick one photo. You should see &quot;…: uploaded&quot; and the photo in{' '}
            <a href="/orders/sort-assign" className="text-blue-400 hover:underline">Sort &amp; Assign</a> with a Phone tag; its key above shows the count.
            After that, use it from Photos: select photos → Share → <K>Send to Tracker</K>.
          </div>

          <div>
            <b className="text-gray-200">If something goes wrong</b>
            <ul className="list-disc pl-5 mt-1 space-y-1">
              <li>One photo failing doesn&apos;t stop the others; its line in the notification says why. Share the same photos again: the ones already uploaded are skipped.</li>
              <li>A blank line in the notification means the answer wasn&apos;t from this app. Usually that is Cloudflare refusing the request: check the CF-Access-Client-Id and Secret headers.</li>
              <li>&quot;invalid or missing upload key&quot;: the Authorization header is wrong or the key was revoked. It must read <K>Bearer</K>, a space, then the key.</li>
              <li>&quot;send a form with a file field&quot;: Request Body isn&apos;t Form, or the field key isn&apos;t exactly <K>file</K>.</li>
            </ul>
          </div>
        </div>
      </details>
    </section>
  );
}

function K({ children }: { children: React.ReactNode }) {
  return <code className="text-gray-200 bg-gray-800 rounded px-1">{children}</code>;
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="block my-2 text-gray-200 bg-gray-800 rounded px-2 py-1.5 break-all select-all">{children}</code>;
}
