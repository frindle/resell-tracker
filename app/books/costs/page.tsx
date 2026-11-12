'use client';

import { useCallback, useEffect, useState } from 'react';
import { BooksShell, Off, Table, api, money } from '../ui';

type Cost = { id: number; date: string; amountCents: number; category: string; vendor: string | null; purpose: string | null; businessPct: number; voidedAt: string | null; attachmentName: string | null; paidFromAccount: { name: string } };
type Acct = { id: number; code: string; name: string; type: string };

export default function CostsPage() {
  const [on, setOn] = useState(true);
  const [costs, setCosts] = useState<Cost[]>([]);
  const [cats, setCats] = useState<string[]>([]);
  const [accts, setAccts] = useState<Acct[]>([]);
  const [err, setErr] = useState('');
  const today = new Date().toLocaleDateString('en-CA');
  const [f, setF] = useState({ date: today, amount: '', category: 'supplies', vendor: '', purpose: '', businessPct: '100', business: 'resell', paidFromAccountId: '' });
  const [file, setFile] = useState<File | null>(null);
  const [newBank, setNewBank] = useState('');

  const load = useCallback(async () => {
    const c = await api<{ costs: Cost[]; categories: string[] }>('/api/books/costs');
    if (!c.ok) { setOn(false); return; }
    setCosts(c.data.costs); setCats(c.data.categories);
    const a = await api<Acct[]>('/api/books/accounts');
    if (a.ok) setAccts((a.data as unknown as Acct[]).filter(x => x.type === 'asset' || x.type === 'liability'));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function submit() {
    setErr('');
    const fd = new FormData();
    for (const [k, v] of Object.entries(f)) fd.append(k, v);
    if (file) fd.append('file', file);
    const r = await fetch('/api/books/costs', { method: 'POST', body: fd });
    if (!r.ok) { setErr((await r.json().catch(() => ({}))).error ?? 'failed'); return; }
    setF({ ...f, amount: '', vendor: '', purpose: '' }); setFile(null); load();
  }
  async function voidCost(id: number) {
    if (!confirm('Void this cost? It stays in the journal with a reversing entry.')) return;
    await api(`/api/books/costs/${id}`, 'PATCH', { void: true }); load();
  }
  async function addBank() {
    if (!newBank.trim()) return;
    const r = await api('/api/books/accounts', 'POST', { name: newBank }); if (r.ok) { setNewBank(''); load(); }
  }
  if (!on) return <BooksShell title="Costs"><Off /></BooksShell>;
  return (
    <BooksShell title="Costs">
      <div className="border border-gray-800 rounded-md p-3 space-y-3">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <label className="text-xs text-gray-400 space-y-1"><span>Date</span><input className="input" value={f.date} onChange={e => setF({ ...f, date: e.target.value })} /></label>
          <label className="text-xs text-gray-400 space-y-1"><span>Amount $</span><input className="input" value={f.amount} onChange={e => setF({ ...f, amount: e.target.value })} /></label>
          <label className="text-xs text-gray-400 space-y-1"><span>Category</span><select className="input" value={f.category} onChange={e => setF({ ...f, category: e.target.value })}>{cats.map(c => <option key={c}>{c}</option>)}</select></label>
          <label className="text-xs text-gray-400 space-y-1"><span>Business use %</span><input className="input" value={f.businessPct} onChange={e => setF({ ...f, businessPct: e.target.value })} /></label>
          <label className="text-xs text-gray-400 space-y-1"><span>Vendor</span><input className="input" value={f.vendor} onChange={e => setF({ ...f, vendor: e.target.value })} /></label>
          <label className="text-xs text-gray-400 space-y-1"><span>Purpose</span><input className="input" value={f.purpose} onChange={e => setF({ ...f, purpose: e.target.value })} /></label>
          <label className="text-xs text-gray-400 space-y-1"><span>Paid from</span>
            <select className="input" value={f.paidFromAccountId} onChange={e => setF({ ...f, paidFromAccountId: e.target.value })}><option value="">Choose...</option>{accts.map(a => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></label>
          <label className="text-xs text-gray-400 space-y-1"><span>Receipt (optional)</span><input type="file" className="text-xs" onChange={e => setFile(e.target.files?.[0] ?? null)} /></label>
        </div>
        <div className="flex items-center gap-3">
          <button className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-3 py-1.5 rounded-md" onClick={submit}>Add cost</button>
          <span className="text-xs text-gray-500">The non-business share goes to Owner draws.</span>
          {err && <span className="text-xs text-red-400">{err}</span>}
        </div>
        <div className="flex items-end gap-2 text-xs text-gray-400"><label className="space-y-1"><span>New bank account</span><input className="input" value={newBank} onChange={e => setNewBank(e.target.value)} placeholder="Checking" /></label><button className="border border-gray-600 text-gray-200 px-2 py-1.5 rounded-md" onClick={addBank}>Add</button></div>
      </div>
      <Table head={['Date', 'Category', 'Vendor', 'Amount', 'Business %', 'Paid from', 'Receipt', '']} rows={costs.map(c => [
        c.date, c.category, c.vendor ?? '', <span key="a" className={c.voidedAt ? 'line-through text-gray-500' : ''}>{money(c.amountCents)}</span>, `${c.businessPct}%`, c.paidFromAccount.name,
        c.attachmentName ? <a key="r" className="underline" href={`/api/books/costs/${c.id}/attachment`} target="_blank">{c.attachmentName}</a> : '',
        c.voidedAt ? 'voided' : <button key="v" className="text-red-400 text-xs" onClick={() => voidCost(c.id)}>Void</button>,
      ])} />
    </BooksShell>
  );
}
