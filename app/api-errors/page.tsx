'use client';

import { useEffect, useState } from 'react';

type ApiError = {
  id: number;
  group: string;
  endpoint: string;
  method: string | null;
  status: number | null;
  body: string | null;
  orderId: number | null;
  context: string | null;
  createdAt: string;
};

const GROUP_COLOR: Record<string, string> = {
  BG:     'text-blue-300 bg-blue-900/30 border-blue-800/50',
  BFMR:   'text-yellow-300 bg-yellow-900/30 border-yellow-800/50',
  CC:     'text-purple-300 bg-purple-900/30 border-purple-800/50',
  Costco: 'text-red-300 bg-red-900/30 border-red-800/50',
  BigSky: 'text-sky-300 bg-sky-900/30 border-sky-800/50',
};

export default function ApiErrorsPage() {
  const [errors, setErrors] = useState<ApiError[]>([]);
  const [group, setGroup] = useState<string>('');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);

  async function load() {
    setLoading(true);
    const params = new URLSearchParams();
    if (group) params.set('group', group);
    const res = await fetch(`/api/api-errors?${params}`);
    const data = await res.json() as { errors?: ApiError[] };
    setErrors(data.errors ?? []);
    setLoading(false);
  }

  useEffect(() => { load(); }, [group]);
  // Mark errors as seen when the user opens the page so the navbar
  // badge clears. Fire-and-forget — we don't care about the response.
  useEffect(() => { void fetch('/api/api-errors/unread-count', { method: 'POST' }); }, []);

  async function clearAll() {
    if (!confirm(group ? `Clear all ${group} errors?` : 'Clear ALL API errors?')) return;
    setClearing(true);
    try {
      const params = new URLSearchParams();
      if (group) params.set('group', group);
      await fetch(`/api/api-errors?${params}`, { method: 'DELETE' });
      await load();
    } finally {
      setClearing(false);
    }
  }

  function toggle(id: number) {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  const groups = Array.from(new Set(errors.map(e => e.group)));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">API Errors</h1>
        <div className="flex items-center gap-2">
          <select value={group} onChange={e => setGroup(e.target.value)} className="bg-gray-900 border border-gray-700 rounded-md px-3 py-1.5 text-sm text-gray-300">
            <option value="">All groups</option>
            {Object.keys(GROUP_COLOR).map(g => <option key={g} value={g}>{g}</option>)}
            {groups.filter(g => !(g in GROUP_COLOR)).map(g => <option key={g} value={g}>{g}</option>)}
          </select>
          <button onClick={() => load()} disabled={loading} className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-sm px-3 py-1.5 rounded-md transition-colors disabled:opacity-50">
            {loading ? 'Loading…' : 'Refresh'}
          </button>
          <button onClick={clearAll} disabled={clearing || errors.length === 0} className="bg-red-900/40 hover:bg-red-900/60 border border-red-800 text-red-300 text-sm px-3 py-1.5 rounded-md transition-colors disabled:opacity-50">
            {clearing ? 'Clearing…' : `Clear${group ? ` ${group}` : ' all'}`}
          </button>
        </div>
      </div>

      {errors.length === 0 ? (
        <div className="text-gray-500 text-sm">No errors logged{group ? ` for ${group}` : ''}.</div>
      ) : (
        <div className="space-y-2">
          {errors.map(e => {
            const isOpen = expanded.has(e.id);
            const color = GROUP_COLOR[e.group] ?? 'text-gray-300 bg-gray-800 border-gray-700';
            return (
              <div key={e.id} className="rounded-lg border border-gray-800 bg-gray-900/40">
                <button onClick={() => toggle(e.id)} className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-gray-900/60 transition-colors">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium border ${color}`}>{e.group}</span>
                    {e.status != null && <span className={`text-sm font-mono ${e.status >= 500 ? 'text-red-400' : e.status >= 400 ? 'text-orange-300' : 'text-gray-300'}`}>{e.status}</span>}
                    {e.method && <span className="text-xs text-gray-500 font-mono">{e.method}</span>}
                    <span className="text-sm text-gray-300 truncate flex-1 font-mono">{e.endpoint}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-gray-500">
                    {e.orderId && <span>order #{e.orderId}</span>}
                    <span>{new Date(e.createdAt).toLocaleString()}</span>
                    <span className="text-gray-600">{isOpen ? '▾' : '▸'}</span>
                  </div>
                </button>
                {isOpen && (
                  <div className="px-4 pb-3 space-y-2 border-t border-gray-800">
                    {e.context && (
                      <div className="text-xs">
                        <span className="text-gray-500">context:</span> <span className="text-gray-300">{e.context}</span>
                      </div>
                    )}
                    {e.body && (
                      <div className="text-xs">
                        <span className="text-gray-500">body:</span>
                        <pre className="mt-1 bg-gray-950 border border-gray-800 rounded p-2 text-gray-300 overflow-x-auto whitespace-pre-wrap break-all">{e.body}</pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
