'use client';

import { useCallback, useEffect, useState } from 'react';
import { Table, api, money } from '../ui';

export type MerchantGroup = {
  key: string; pattern: string; count: number; totalCents: number; firstDate: string; lastDate: string;
  accounts: { id: number; name: string }[]; samples: string[]; ruled: boolean; allUnmapped: boolean; kept: boolean;
};
const fetchMerchants = (kept: boolean) => api<{ groups: MerchantGroup[] }>(`/api/books/bank/merchants${kept ? '?kept=1' : ''}`);

/** The Merchants tab: open debits grouped by merchant; Personal / Ignore open the page's rule editor, Keep hides the merchant. */
export default function Merchants({ onRule, onChanged, reloadKey }: { onRule: (g: MerchantGroup, action: 'personal' | 'ignore') => void; onChanged: () => void; reloadKey: number }) {
  const [rows, setRows] = useState<MerchantGroup[] | null>(null);
  const [showKept, setShowKept] = useState(false);
  const [msg, setMsg] = useState('');
  const show = useCallback((r: Awaited<ReturnType<typeof fetchMerchants>>) => {
    if (r.ok) setRows(r.data.groups); else setMsg(`Could not load: ${r.data.error ?? 'error'}`);
  }, []);
  const load = useCallback(async () => show(await fetchMerchants(showKept)), [show, showKept]);
  useEffect(() => {
    let live = true;
    fetchMerchants(showKept).then(r => { if (live) show(r); });
    return () => { live = false; };
  }, [showKept, reloadKey, show]);
  const keep = async (key: string, v: boolean) => {
    const r = await api('/api/books/bank/merchants', 'POST', { key, keep: v });
    if (!r.ok) setMsg(`Failed: ${r.data.error ?? 'error'}`);
    await load(); onChanged();
  };
  if (!rows) return <div className="text-sm text-gray-500">{msg || 'Loading...'}</div>;
  const list = showKept ? rows.filter(g => g.kept) : rows;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3 text-sm">
        <h2 className="font-medium text-white">Merchants</h2>
        <label className="text-xs text-gray-400 inline-flex items-center gap-1"><input type="checkbox" checked={showKept} onChange={e => setShowKept(e.target.checked)} />show kept</label>
      </div>
      <p className="text-xs text-gray-500">Open debits grouped by merchant, biggest spend first. Personal and Ignore start a rule you can edit before saving; it also applies to the rows already here. Keep (resell) hides a merchant you have reviewed. There is no delete: a synced row would come back, so Personal or Ignore is how a row goes away.</p>
      {msg && <div className="text-xs text-gray-400">{msg}</div>}
      {list.length === 0 ? <div className="text-xs text-gray-500">{showKept ? 'Nothing kept.' : 'No open merchants.'}</div> : (
        <Table head={['Merchant', 'Rows', 'Total', 'Dates', 'Accounts', 'Examples', '']} rows={list.map(g => [
          <div key="k"><div>{g.key}</div>{g.ruled && <div className="text-xs text-blue-300">a rule already matches</div>}</div>,
          String(g.count),
          money(-g.totalCents),
          <span key="d">{g.firstDate}{g.lastDate !== g.firstDate ? ` to ${g.lastDate}` : ''}</span>,
          g.accounts.map(a => a.name).join(', '),
          <div key="s" className="text-xs text-gray-500">{g.samples.map((s, i) => <div key={i}>{s}</div>)}</div>,
          <div key="x" className="flex flex-wrap gap-2 text-xs">
            {g.kept
              ? <button className="text-blue-400" onClick={() => keep(g.key, false)}>Undo</button>
              : <>
                  <button className="text-amber-300" onClick={() => onRule(g, 'personal')}>Personal</button>
                  {g.allUnmapped && <button className="text-gray-300" onClick={() => onRule(g, 'ignore')}>Ignore</button>}
                  <button className="text-green-300" onClick={() => keep(g.key, true)}>Keep (resell)</button>
                </>}
          </div>,
        ])} />
      )}
    </div>
  );
}
