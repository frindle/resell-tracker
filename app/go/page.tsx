'use client';

// Middle page for deal links: /go?url=<encoded deal link>&src=<bfmr|bg|bigsky|cok>
// Optional deal context from our own pages: merchant, category, value.
// The browser extension sends only url (and src), so everything else is derived.
import { useEffect, useMemo, useState } from 'react';
import { cleanUrl, hostOf, isHttpUrl } from '@/lib/linkClean';
import { clickUrlBody, merchantForHost, portalOptions, type PortalOption, type PortalRateRow } from '@/lib/portalPicker';

const SRC_LABEL: Record<string, string> = { bfmr: 'BFMR', bg: 'BuyingGroup', bigsky: 'BigSky', cok: 'Cash Out Kings' };

type Params = { url: string; src: string; merchant: string; category: string; value: number | null };

function readParams(): Params {
  const q = new URLSearchParams(window.location.search);
  const v = parseFloat(q.get('value') ?? '');
  return {
    url: q.get('url') ?? '',
    src: (q.get('src') ?? '').toLowerCase(),
    merchant: q.get('merchant') ?? '',
    category: q.get('category') ?? '',
    value: Number.isFinite(v) ? v : null,
  };
}

export default function GoPage() {
  const [p, setP] = useState<Params | null>(null);
  const [clean, setClean] = useState<string | null>(null);
  const [rates, setRates] = useState<PortalRateRow[]>([]);
  const [ignored, setIgnored] = useState<string[]>([]);
  const [activated, setActivated] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saveErr, setSaveErr] = useState('');

  useEffect(() => {
    const params = readParams();
    setP(params);
    if (!isHttpUrl(params.url)) return;
    // Show the quick offline scrub at once, then replace it with the full resolve (follows redirects).
    setClean(cleanUrl(params.url));
    fetch(`/api/bfmr/resolve-link?url=${encodeURIComponent(params.url)}`)
      .then(r => (r.ok ? r.json() : null))
      .then((d: { url?: string } | null) => { if (d?.url) setClean(d.url); })
      .catch(() => {});
    fetch('/api/portal-rates').then(r => (r.ok ? r.json() : [])).then(setRates).catch(() => {});
    fetch('/api/settings').then(r => (r.ok ? r.json() : {})).then((s: Record<string, string>) => {
      if (s.ignored_portals) { try { setIgnored(JSON.parse(s.ignored_portals)); } catch { /* keep none */ } }
    }).catch(() => {});
  }, []);

  const merchant = useMemo(() => {
    if (!p) return '';
    if (p.merchant) return p.merchant;
    const host = hostOf(clean ?? p.url);
    return merchantForHost(host, [...new Set(rates.map(r => r.merchant))]) ?? '';
  }, [p, clean, rates]);

  const options = useMemo(
    () => portalOptions(rates, { merchant, category: p?.category, ignored, dealValue: p?.value ?? null }),
    [rates, merchant, p, ignored],
  );

  if (!p) return <div className="text-gray-500 py-12 text-center">Loading…</div>;

  if (!isHttpUrl(p.url)) {
    return (
      <div className="max-w-xl space-y-3">
        <h1 className="text-2xl font-bold">Open deal link</h1>
        <p className="text-sm text-red-300">Missing or invalid link. This page opens with /go?url=&lt;deal link&gt;.</p>
      </div>
    );
  }

  const target = clean ?? p.url;
  const host = hostOf(target);

  async function saveLink(o: PortalOption) {
    const portal = o.portal;
    setSaveErr('');
    const r = await fetch('/api/portal-rates/click-url', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(clickUrlBody(o, draft)),
    });
    if (!r.ok) { setSaveErr(await r.text()); return; }
    const { clickUrl } = await r.json() as { clickUrl: string | null };
    setRates(prev => prev.map(x => (x.merchant === o.merchant && x.portal === portal ? { ...x, clickUrl } : x)));
    setEditing(null);
    setDraft('');
  }

  // Direct window.open from the click so the browser allows the new tab.
  function openPortal(portal: string, url: string) {
    window.open(url, '_blank', 'noopener,noreferrer');
    setActivated(portal);
  }

  return (
    <div className="max-w-xl space-y-5">
      <div>
        <h1 className="text-2xl font-bold">Open deal link</h1>
        <p className="text-gray-400 text-sm mt-1 break-words">
          {p.src && <span>{Object.hasOwn(SRC_LABEL, p.src) ? SRC_LABEL[p.src] : p.src} deal. </span>}
          {host && <span>Goes to <span className="text-gray-200">{host}</span>.</span>}
        </p>
      </div>

      <div className="rounded-lg border border-gray-800 p-4 space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 className="text-sm font-semibold text-gray-200">
            Portals for {merchant || 'this merchant'}{p.category ? ` (${p.category})` : ''}
          </h2>
          {p.value !== null && <span className="text-xs text-gray-500">on ${p.value.toFixed(2)}</span>}
        </div>

        {!merchant ? (
          <p className="text-sm text-gray-500">No merchant recognized for this link, so no portal rates to show.</p>
        ) : options.length === 0 ? (
          <p className="text-sm text-gray-500">No portal rates saved for {merchant}.</p>
        ) : (
          <ul className="space-y-2">
            {options.map(o => (
              <li key={o.portal} className={`rounded border px-3 py-2 ${activated === o.portal ? 'border-green-700 bg-green-950/20' : 'border-gray-800'} ${o.excluded ? 'opacity-60' : ''}`}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span className="text-sm text-gray-200 min-w-0 break-words">{o.portal}</span>
                  <span className={`text-xs font-mono ${o.excluded ? 'text-red-400' : 'text-blue-400'}`}>{o.excluded ? 'excluded' : o.rate}</span>
                  {o.value && !o.excluded && <span className="text-xs text-gray-400">{o.value}</span>}
                  <span className="ml-auto flex flex-wrap items-center gap-2">
                    {o.clickUrl && isHttpUrl(o.clickUrl) ? (
                      <button
                        onClick={() => openPortal(o.portal, o.clickUrl!)}
                        className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded transition-colors"
                      >
                        Open via {o.portal}
                      </button>
                    ) : editing === o.portal ? null : (
                      <button
                        onClick={() => { setEditing(o.portal); setDraft(''); setSaveErr(''); }}
                        className="text-xs border border-gray-700 text-gray-300 hover:bg-gray-800 px-3 py-1.5 rounded transition-colors"
                      >
                        add link
                      </button>
                    )}
                  </span>
                </div>
                {editing === o.portal && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <input
                      type="url"
                      autoFocus
                      value={draft}
                      onChange={e => setDraft(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') saveLink(o); }}
                      placeholder={`${o.portal} store page for ${merchant}`}
                      className="min-w-0 flex-1 basis-48 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
                    />
                    <button onClick={() => saveLink(o)} disabled={!draft.trim()}
                      className="text-xs bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white px-3 py-1 rounded">Save</button>
                    <button onClick={() => setEditing(null)} className="text-xs text-gray-500 hover:text-gray-300">Cancel</button>
                    {saveErr && <span className="text-xs text-red-400 w-full">{saveErr}</span>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {activated && (
          <a
            href={target}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm bg-green-700 hover:bg-green-600 text-white px-4 py-2 rounded-md transition-colors"
          >
            Open product (clean link)
          </a>
        )}
        <a
          href={target}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm border border-gray-700 text-gray-300 hover:bg-gray-800 px-4 py-2 rounded-md transition-colors"
        >
          Open clean link (no portal)
        </a>
        <a
          href={p.url}
          target="_blank"
          rel="noopener noreferrer"
          title="The link as it was sent, in case the clean link drops something (Walmart seller, Target preselect)"
          className="text-sm text-gray-400 hover:text-gray-200 underline px-2 py-2"
        >
          Open original link
        </a>
      </div>
      {activated && (
        <p className="text-xs text-gray-500">
          {activated} should now be active in your browser. Open the product with the clean link above.
        </p>
      )}
    </div>
  );
}
