'use client';

import { useCallback, useEffect, useState } from 'react';

type Row = {
  id: number;
  fromDomain: string;
  subject: string;
  receivedAt: string | null;
  createdAt: string;
  status: 'pending' | 'done' | 'failed' | 'retry';
  error: string | null;
  category: string | null;
  recommend: 'ingest' | 'ignore' | 'review' | null;
  reason: string | null;
  ingestKind: string | null;
  fields: Record<string, string>;
  ruleFromDomain: string | null;
  ruleSubject: string | null;
  ignoreRule: { fromDomain: string; subjectContains: string | null } | null;
  decision: 'ignored' | 'kept' | 'needs_parser' | 'dismissed' | null;
};
type Rule = { id: number; fromDomain: string; subjectContains: string | null; hits: number; lastHitAt: string | null };
type Data = { enabled: boolean; configured: boolean; rows: Row[]; rules: Rule[] };

const RECOMMEND_BADGE: Record<string, string> = {
  ingest: 'bg-emerald-900/40 text-emerald-300',
  ignore: 'bg-gray-800 text-gray-400',
  review: 'bg-amber-900/40 text-amber-300',
};

const DECISION_LABEL: Record<string, string> = { ignored: 'Ignored', kept: 'Kept', needs_parser: 'Needs a parser', dismissed: 'Dismissed' };

function when(s: string | null): string {
  return s ? new Date(s).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'short', timeStyle: 'short' }) : '—';
}

export default function InboxTriage() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/inbox-triage');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/inbox-triage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <p className="text-gray-500 text-sm py-8 text-center">{error || 'Loading…'}</p>;

  const btn = 'text-xs px-2 py-1 rounded-md bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 disabled:opacity-40 transition-colors';

  return (
    <div className="space-y-6">
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-2">
        <div className="flex items-center justify-between gap-4">
          <h2 className="font-semibold text-base">Inbox Triage</h2>
          <button
            onClick={() => post({ action: 'toggle', on: !data.enabled })}
            disabled={busy}
            className={`text-sm px-4 py-2 rounded-md transition-colors disabled:opacity-40 ${data.enabled ? 'bg-blue-600 hover:bg-blue-500 text-white' : 'bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300'}`}
          >
            {data.enabled ? 'On' : 'Off'}
          </button>
        </div>
        <p className="text-gray-400 text-sm">
          Unrecognized emails are sent, with personal details removed, to the home lab&apos;s local model for a recommendation. Nothing is deleted or imported.
        </p>
        {!data.configured && (
          <p className="text-yellow-500 text-sm">The queue is not configured: set DIGEST_QUEUE_URL and QUEUE_PROMPT_TOKEN, or nothing will be sent.</p>
        )}
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      {data.rows.length === 0 ? (
        <p className="text-gray-600 text-sm">No unrecognized emails yet.</p>
      ) : (
        <div className="rounded-lg border border-gray-800 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-900 text-gray-400 text-xs uppercase">
              <tr>
                <th className="px-3 py-2 text-left">Received</th>
                <th className="px-3 py-2 text-left">From</th>
                <th className="px-3 py-2 text-left">Subject</th>
                <th className="px-3 py-2 text-left">Category</th>
                <th className="px-3 py-2 text-left">Recommendation</th>
                <th className="px-3 py-2 text-left">Reason</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {data.rows.map(r => (
                <tr key={r.id} className={r.decision ? 'opacity-50' : 'hover:bg-gray-900/40'}>
                  <td className="px-3 py-2 text-gray-400 whitespace-nowrap">{when(r.receivedAt ?? r.createdAt)}</td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-300">{r.fromDomain || '—'}</td>
                  <td className="px-3 py-2 max-w-[220px]"><div className="truncate" title={r.subject}>{r.subject || '—'}</div></td>
                  <td className="px-3 py-2 text-gray-400">{r.category ?? '—'}</td>
                  <td className="px-3 py-2">
                    {r.recommend ? <span className={`text-xs px-2 py-0.5 rounded-full ${RECOMMEND_BADGE[r.recommend] ?? ''}`}>{r.recommend}</span> : '—'}
                  </td>
                  <td className="px-3 py-2 max-w-[280px] text-gray-300">
                    <div>{r.reason ?? '—'}</div>
                    {r.ingestKind && <div className="text-xs text-emerald-400 mt-0.5">Record as: {r.ingestKind}</div>}
                    {Object.keys(r.fields).length > 0 && (
                      <div className="text-xs text-gray-500 mt-0.5">
                        {Object.entries(r.fields).map(([k, v]) => <div key={k}>{k}: {v}</div>)}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs whitespace-nowrap">
                    {r.decision
                      ? <span className="text-gray-400">{DECISION_LABEL[r.decision]}</span>
                      : r.status === 'failed'
                        ? <span className="text-red-400">failed{r.error ? ` (${r.error})` : ''}</span>
                        : r.status === 'retry' ? <span className="text-yellow-400">will retry</span>
                        : r.status === 'pending' ? <span className="text-yellow-400">waiting for the model</span> : <span className="text-green-400">ready</span>}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap space-x-1">
                    {!r.decision && r.status === 'done' && (<>
                      {r.ignoreRule && (
                        <button className={btn} disabled={busy} onClick={() => post({ id: r.id, action: 'ignore_sender' })}
                          title={`Ignore ${r.ignoreRule.fromDomain}${r.ignoreRule.subjectContains ? ` with "${r.ignoreRule.subjectContains}" in the subject` : ''} from now on`}>Ignore {r.ignoreRule.fromDomain}</button>
                      )}
                      <button className={btn} disabled={busy} onClick={() => post({ id: r.id, action: 'keep' })}>Keep</button>
                      <button className={btn} disabled={busy} onClick={() => post({ id: r.id, action: 'needs_parser' })}>Needs parser</button>
                      <button className={btn} disabled={busy} onClick={() => post({ id: r.id, action: 'dismiss' })}>Dismiss</button>
                    </>)}
                    {!r.decision && r.status === 'retry' && (
                      <button className={btn} disabled={busy} onClick={() => post({ id: r.id, action: 'dismiss' })}>Dismiss</button>
                    )}
                    {!r.decision && r.status === 'failed' && (<>
                      <button className={btn} disabled={busy} onClick={() => post({ id: r.id, action: 'retry' })}>Retry</button>
                      <button className={btn} disabled={busy} onClick={() => post({ id: r.id, action: 'dismiss' })}>Dismiss</button>
                    </>)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="space-y-2">
        <h3 className="font-semibold text-sm">Ignore rules</h3>
        {data.rules.length === 0 ? (
          <p className="text-gray-600 text-sm">No ignore rules yet.</p>
        ) : (
          <div className="rounded-lg border border-gray-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-900 text-gray-400 text-xs uppercase">
                <tr>
                  <th className="px-4 py-2 text-left">From domain</th>
                  <th className="px-4 py-2 text-left">Subject contains</th>
                  <th className="px-4 py-2 text-right">Hits</th>
                  <th className="px-4 py-2 text-left">Last hit</th>
                  <th className="px-4 py-2 w-10"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {data.rules.map(r => (
                  <tr key={r.id} className="hover:bg-gray-900/40">
                    <td className="px-4 py-2 font-mono text-xs text-gray-300">{r.fromDomain}</td>
                    <td className="px-4 py-2 text-gray-400">{r.subjectContains ?? <span className="text-gray-600">any</span>}</td>
                    <td className="px-4 py-2 text-right text-gray-400">{r.hits}</td>
                    <td className="px-4 py-2 text-gray-500 whitespace-nowrap">{r.lastHitAt ? when(r.lastHitAt) : '—'}</td>
                    <td className="px-4 py-2 text-right">
                      <button onClick={() => post({ action: 'delete_rule', ruleId: r.id })} disabled={busy}
                        className="text-gray-600 hover:text-red-400 transition-colors text-xs">
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
