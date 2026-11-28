'use client';

import { useCallback, useEffect, useState } from 'react';
import { BooksShell, Off, Table, api, money } from '../ui';
import { merchantKey } from '@/lib/books/match';
import Shortfalls from './Shortfalls';
import Payees from './Payees';
import Merchants, { type MerchantGroup } from './Merchants';
import RowActions from './RowActions';
import Review from './Review';
import TxnStatus from './TxnStatus';
import type { Txn } from './txnTypes';

type Acct = {
  id: number; name: string; orgName: string | null; kind: string; last4: string | null; provider: string;
  creditCardId: number | null; ledgerAccountId: number | null; balanceCents: number | null; balanceDate: string | null; hidden: boolean;
  counts: Record<string, number>;
};
type FeedError = { code: string; msg: string; connId: string | null; accountId: string | null };
type Overview = {
  encryptionConfigured: boolean;
  connection: { id: number; lastSyncAt: string | null; lastError: string | null; errors: FeedError[] } | null;
  accounts: Acct[]; cards: { id: number; name: string; last4: string | null }[]; ledger: { id: number; code: string; name: string }[];
};
type PayoutRow = { orderId: number; orderNumber: string | null; platform: string; item: string | null; buyer: string | null; paidDay: string; openCents: number };
type Rule = {
  id: number; bankAccountId: number | null; pattern: string; isRegex: boolean; sign: string; minCents: number | null; maxCents: number | null;
  action: string; costCategory: string | null; business: string | null; enabled: boolean; hits: number;
};
type Draft = { pattern: string; isRegex: boolean; sign: string; bankAccountId: string; min: string; max: string; action: string; costCategory: string; business: string };

const dollarsToCents = (v: string) => (v.trim() === '' ? null : Math.round(Number(v) * 100));

export default function BankPage() {
  const [ov, setOv] = useState<Overview | null>(null);
  const [off, setOff] = useState(false);
  const [txns, setTxns] = useState<Txn[]>([]);
  const [token, setToken] = useState('');
  const [msg, setMsg] = useState('');
  const [fAcct, setFAcct] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [hidePersonal, setHidePersonal] = useState(true);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [rules, setRules] = useState<Rule[]>([]);
  const [cats, setCats] = useState<string[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tab, setTab] = useState<'txns' | 'review' | 'shortfalls' | 'payees' | 'merchants'>('txns');
  const [rvRows, setRvRows] = useState<Txn[] | null>(null); // the open rows the Review tab steps through (null until loaded)
  const [showHidden, setShowHidden] = useState(false);
  const inReview = tab === 'review';
  const [merchKey, setMerchKey] = useState(0);
  const [pick, setPick] = useState<{ id: number; amountCents: number; rows: PayoutRow[]; chosen: Set<number> } | null>(null);
  const [costFor, setCostFor] = useState<{ id: number; category: string; business: string } | null>(null);

  const load = useCallback(async () => {
    const r = await api<Overview>('/api/books/bank');
    if (!r.ok) { setOff(true); return; }
    setOv(r.data);
    const q = new URLSearchParams({ limit: '200', ...(fAcct ? { accountId: fAcct } : {}), ...(fStatus ? { status: fStatus } : {}), ...(hidePersonal ? { hidePersonal: '1' } : {}) });
    const t = await api<Txn[]>(`/api/books/bank/transactions?${q}`);
    if (t.ok) setTxns(t.data as unknown as Txn[]);
    const ru = await api<{ rules: Rule[]; categories: string[] }>('/api/books/bank/rules');
    if (ru.ok) { setRules(ru.data.rules); setCats(ru.data.categories); }
    if (inReview) {
      // Open rows only: the two open statuses, newest first, merged.
      const open = await Promise.all(['unmatched', 'suggested'].map(st => api<Txn[]>(`/api/books/bank/transactions?${new URLSearchParams({ limit: '1000', status: st })}`)));
      if (open.every(x => x.ok)) setRvRows(open.flatMap(x => x.data as unknown as Txn[]).sort((x, y) => (x.postedDate === y.postedDate ? y.id - x.id : x.postedDate < y.postedDate ? 1 : -1)));
    }
  }, [fAcct, fStatus, hidePersonal, inReview]);
  useEffect(() => { load(); }, [load]);

  async function run(label: string, fn: () => Promise<{ ok: boolean; data: { error?: string } & Record<string, unknown> }>) {
    setBusy(true); setMsg(`${label}...`);
    const r = await fn();
    setMsg(r.ok ? (r.data.syncError ? `${label}: connected, but the first sync failed: ${r.data.syncError}` : `${label}: done`) : `${label} failed: ${r.data.error}`);
    setBusy(false);
    await load();
    return r.ok;
  }
  const connect = () => run('Connect', async () => { const r = await api<Record<string, unknown>>('/api/books/bank/connect', 'POST', { setupToken: token }); if (r.ok) setToken(''); return r; });
  const sync = () => run('Sync', () => api<Record<string, unknown>>('/api/books/bank/sync', 'POST'));
  const rematch = () => run('Match', () => api<Record<string, unknown>>('/api/books/bank/match', 'POST'));
  const link = (id: number, body: Record<string, unknown>) => api(`/api/books/bank/accounts/${id}`, 'PATCH', body).then(load);
  const act = (id: number, body: Record<string, unknown>) => run('Update', () => api<Record<string, unknown>>(`/api/books/bank/transactions/${id}`, 'PATCH', body));
  const personalSelected = () => run('Personal', async () => {
    const r = await api<Record<string, unknown>>('/api/books/bank/transactions/personal', 'POST', { txnIds: [...sel] });
    if (r.ok) setSel(new Set());
    return r;
  });
  const ignoreSelected = () => run('Ignore', async () => {
    const r = await api<Record<string, unknown>>('/api/books/bank/transactions/ignore', 'POST', { txnIds: [...sel] });
    if (r.ok) setSel(new Set());
    return r;
  });
  // Ignore is only for accounts that are not in the books; every selected row must be on one that is in the list.
  const canIgnoreSel = sel.size > 0 && txns.filter(t => sel.has(t.id)).length === sel.size && txns.every(t => !sel.has(t.id) || !t.mapped);
  // From the Merchants tab: the merchant's pattern (plain text, debits, any account), the user edits it, then saves.
  const startMerchantRule = (g: MerchantGroup, action: 'personal' | 'ignore') => setDraft({
    // One account: the rule starts on that account, so a retailer's personal rule can't catch the resell cards' charges.
    pattern: g.pattern, isRegex: false, sign: 'debit', bankAccountId: g.accounts.length === 1 ? String(g.accounts[0].id) : '',
    min: '', max: '', action, costCategory: cats[0] ?? '', business: 'resell',
  });
  // "Make a rule from this": the merchant word, the sign, this row's account; the user edits, then saves.
  const startRule = (t: Txn) => setDraft({
    pattern: merchantKey(t.description) || t.description.slice(0, 40), isRegex: false, sign: t.amountCents < 0 ? 'debit' : 'credit',
    bankAccountId: String(t.accountId), min: '', max: '', action: 'personal', costCategory: cats[0] ?? '', business: 'resell',
  });
  const saveRule = () => draft && run('Save rule', async () => {
    const r = await api<Record<string, unknown>>('/api/books/bank/rules', 'POST', {
      pattern: draft.pattern, isRegex: draft.isRegex, sign: draft.sign, bankAccountId: draft.bankAccountId ? Number(draft.bankAccountId) : null,
      minCents: dollarsToCents(draft.min), maxCents: dollarsToCents(draft.max), action: draft.action,
      ...(draft.action === 'cost' ? { costCategory: draft.costCategory, business: draft.business } : {}),
    });
    if (r.ok) { setDraft(null); setMerchKey(k => k + 1); }
    return r;
  });
  // A deposit that covers several orders: the open payout orders with checkboxes and a running total against the deposit.
  const startPick = async (t: Txn) => {
    const r = await api<{ payouts: PayoutRow[] }>('/api/books/bank/payouts');
    if (r.ok) setPick({ id: t.id, amountCents: t.amountCents, rows: r.data.payouts, chosen: new Set() });
    else setMsg(`Could not load orders: ${(r.data as { error?: string }).error ?? 'error'}`);
  };
  const startCost = (t: Txn) => setCostFor({ id: t.id, category: cats[0] ?? '', business: 'resell' });
  const rowHandlers = { act, startPick, startRule, startCost };
  const toggle = (id: number) => setSel(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  async function upload(file: File | null) {
    if (!file) return;
    setMsg('Importing...');
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch('/api/books/bank/ofx', { method: 'POST', body: fd });
    const d = await r.json().catch(() => ({}));
    setMsg(r.ok ? `Imported ${d.inserted} new, ${d.updated} changed (${d.accounts} account${d.accounts === 1 ? '' : 's'})` : `Import failed: ${d.error}`);
    load();
  }

  if (off) return <BooksShell title="Bank feed"><Off /></BooksShell>;
  if (!ov) return <BooksShell title="Bank feed"><div className="text-gray-500 text-sm">Loading...</div></BooksShell>;
  const c = ov.connection;
  const hiddenAccts = ov.accounts.filter(a => a.hidden);
  const shownAccts = showHidden ? ov.accounts : ov.accounts.filter(a => !a.hidden);

  return (
    <BooksShell title="Bank feed">
      <p className="text-sm text-gray-400">Read-only feed from SimpleFIN Bridge, plus OFX/QFX file upload for any bank it cannot reach. Accepting a suggestion links the transaction; it posts to the books only when bank posting is on (Reconcile tab). Ignore is for accounts that are not in your books; on a mapped account use Personal.</p>
      {!ov.encryptionConfigured && <div className="text-sm text-amber-300 border border-amber-700 rounded-md p-3">The server has no valid <code>EXTENSION_DATA_KEY</code> (64 hex characters), so a SimpleFIN connection cannot be saved. File upload still works.</div>}
      {msg && <div className="text-xs text-gray-400 break-all">{msg}</div>}

      <div className="space-y-2">
        <h2 className="text-sm font-medium text-white">SimpleFIN</h2>
        {c ? (
          <div className="flex flex-wrap items-center gap-3 text-sm text-gray-300">
            <span>Connected. Last sync: {c.lastSyncAt ? new Date(c.lastSyncAt).toLocaleString() : 'never'}</span>
            <button disabled={busy} className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-3 py-1.5 rounded-md" onClick={sync}>Sync now</button>
            <button disabled={busy} className="border border-gray-600 text-gray-200 px-3 py-1.5 rounded-md" onClick={rematch}>Re-run matching</button>
            <button disabled={busy} className="text-xs text-red-400" onClick={() => { if (confirm('Disconnect SimpleFIN? Saved accounts and transactions stay.')) run('Disconnect', () => api('/api/books/bank/connect', 'DELETE')); }}>Disconnect</button>
          </div>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-gray-400 space-y-1"><span>Setup Token (from bridge.simplefin.org)</span>
              <input className="input w-96" type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} placeholder="paste the Setup Token" /></label>
            <button disabled={busy || !token.trim() || !ov.encryptionConfigured} className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm px-3 py-1.5 rounded-md" onClick={connect}>Connect</button>
          </div>
        )}
        {c?.lastError && <div className="text-sm text-red-400">Last sync failed: {c.lastError}</div>}
        {c && c.errors.length > 0 && (
          <div className="text-sm text-amber-300 border border-amber-700 rounded-md p-3 space-y-1">
            <div className="font-medium">SimpleFIN reported problems (a bank may need you to sign in again at the bridge):</div>
            {c.errors.map((e, i) => <div key={i}><code className="text-xs">{e.code}</code> {e.msg}</div>)}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <h2 className="text-sm font-medium text-white">Accounts</h2>
        <Table head={['Account', 'Kind', 'Last 4', 'Balance', 'Card', 'Ledger account', 'Open / suggested', '']} rows={shownAccts.map(a => [
          <div key="n"><div>{a.name}</div><div className="text-xs text-gray-500">{a.orgName ?? a.provider}</div></div>,
          a.kind,
          a.last4 ?? '-',
          <div key="b">{money(a.balanceCents)}<div className="text-xs text-gray-500">{a.balanceDate ?? ''}</div></div>,
          <select key="c" className="input" value={a.creditCardId ?? ''} onChange={e => link(a.id, { creditCardId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">none</option>{ov.cards.map(k => <option key={k.id} value={k.id}>{k.name}{k.last4 ? ` ${k.last4}` : ''}</option>)}
          </select>,
          <select key="l" className="input" value={a.ledgerAccountId ?? ''} onChange={e => link(a.id, { ledgerAccountId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">none</option>{ov.ledger.map(k => <option key={k.id} value={k.id}>{k.code} {k.name}</option>)}
          </select>,
          `${a.counts.unmatched ?? 0} / ${a.counts.suggested ?? 0}`,
          a.hidden
            ? <button key="h" className="text-xs text-blue-400" onClick={() => link(a.id, { hidden: false })}>Unhide</button>
            : !a.creditCardId && !a.ledgerAccountId
              ? <button key="h" className="text-xs text-gray-400" title="Leave this account out of the lists, review and matching" onClick={() => link(a.id, { hidden: true })}>Hide</button>
              : <span key="h" />,
        ])} />
        {hiddenAccts.length > 0 && <button className="text-xs text-gray-400" onClick={() => setShowHidden(v => !v)}>{hiddenAccts.length} hidden account{hiddenAccts.length === 1 ? '' : 's'} ({showHidden ? 'hide' : 'show'})</button>}
        <label className="text-xs text-gray-400 inline-flex items-center gap-2">Upload OFX / QFX (up to 25 MB):
          <input type="file" accept=".ofx,.qfx,.xml" onChange={e => { upload(e.target.files?.[0] ?? null); e.target.value = ''; }} /></label>
      </div>

      <div className="flex gap-3 text-sm border-b border-gray-800 pb-1">
        <button className={tab === 'txns' ? 'text-white' : 'text-gray-500'} onClick={() => setTab('txns')}>Transactions</button>
        <button className={tab === 'review' ? 'text-white' : 'text-gray-500'} onClick={() => { setRvRows(null); setTab('review'); }}>Review</button>
        <button className={tab === 'shortfalls' ? 'text-white' : 'text-gray-500'} onClick={() => setTab('shortfalls')}>Shortfalls</button>
        <button className={tab === 'payees' ? 'text-white' : 'text-gray-500'} onClick={() => setTab('payees')}>Payers</button>
        <button className={tab === 'merchants' ? 'text-white' : 'text-gray-500'} onClick={() => setTab('merchants')}>Merchants</button>
      </div>
      {tab === 'shortfalls' && <Shortfalls onChanged={load} />}
      {tab === 'payees' && <Payees onChanged={load} />}
      {tab === 'review' && <Review rows={rvRows} h={rowHandlers} busy={busy} paused={!!(pick || costFor || draft)} onExit={() => setTab('txns')} />}
      {tab === 'merchants' && <Merchants onRule={startMerchantRule} onChanged={load} reloadKey={merchKey} />}

      {tab === 'txns' && <>
      <div className="space-y-2">
        <h2 className="text-sm font-medium text-white">Transactions</h2>
        <div className="flex gap-2 text-sm">
          <select className="input" value={fAcct} onChange={e => setFAcct(e.target.value)}><option value="">All accounts</option>{ov.accounts.filter(a => !a.hidden).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
          <select className="input" value={fStatus} onChange={e => setFStatus(e.target.value)}>
            <option value="">Any status</option>{['unmatched', 'suggested', 'matched', 'ignored'].map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <label className="flex items-center gap-1 text-gray-300"><input type="checkbox" checked={hidePersonal} onChange={e => setHidePersonal(e.target.checked)} />Hide personal</label>
          {sel.size > 0 && <button disabled={busy} className="text-amber-300 border border-amber-700 rounded-md px-2" onClick={personalSelected}>Mark {sel.size} personal</button>}
          {sel.size > 0 && <button disabled={busy || !canIgnoreSel} title={canIgnoreSel ? '' : 'Some selected rows are on an account in your books'} className="text-gray-300 border border-gray-600 rounded-md px-2 disabled:opacity-50" onClick={ignoreSelected}>Ignore {sel.size}</button>}
        </div>
        <Table head={['', 'Date', 'Account', 'Description', 'Amount', 'Status', '']} rows={txns.map(t => {
          const isOpen = t.matchStatus === 'unmatched' || t.matchStatus === 'suggested';
          return [
            isOpen ? <input key="k" type="checkbox" aria-label="select" checked={sel.has(t.id)} onChange={() => toggle(t.id)} /> : <span key="k" />,
            <span key="d">{t.postedDate}{t.pending ? ' (pending)' : ''}<span className="block text-xs text-gray-600" title="Type t#this in another row's Link box to pair the two as a transfer">t#{t.id}</span></span>,
            t.accountName,
            t.description,
            <span key="a" className={t.amountCents < 0 ? 'text-red-300' : 'text-green-300'}>{money(t.amountCents)}</span>,
            <TxnStatus key="s" t={t} />,
            <RowActions key="x" t={t} h={rowHandlers} />,
          ];
        })} />
      </div>

      </>}

      {pick && (() => {
        const total = pick.rows.filter(r => pick.chosen.has(r.orderId)).reduce((a, r) => a + r.openCents, 0);
        const diff = total - pick.amountCents;
        return (
          <div className="border border-gray-700 rounded-md p-3 space-y-2 text-sm">
            <div className="font-medium text-white">Orders paid by deposit row #{pick.id} ({money(pick.amountCents)})</div>
            <div className="max-h-64 overflow-auto space-y-1">
              {pick.rows.map(r => (
                <label key={r.orderId} className="flex items-center gap-2 text-xs text-gray-300">
                  <input type="checkbox" checked={pick.chosen.has(r.orderId)} onChange={() => setPick(p => { if (!p) return p; const n = new Set(p.chosen); if (n.has(r.orderId)) n.delete(r.orderId); else n.add(r.orderId); return { ...p, chosen: n }; })} />
                  <span>#{r.orderId}{r.orderNumber ? ` ${r.orderNumber}` : ''} {r.buyer ?? ''} {r.platform}, paid {r.paidDay}, owed {money(r.openCents)}{r.item ? ` - ${r.item.slice(0, 40)}` : ''}</span>
                </label>
              ))}
              {pick.rows.length === 0 && <div className="text-xs text-gray-500">No paid orders are waiting for a deposit.</div>}
            </div>
            <div className={`text-xs ${diff === 0 ? 'text-green-300' : diff > 0 ? 'text-amber-300' : 'text-red-300'}`}>
              Chosen {money(total)} of {money(pick.amountCents)}{diff > 0 ? `; ${money(diff)} short, you classify it on the Shortfalls tab` : diff < 0 ? '; the orders are owed less than the deposit' : ''}
            </div>
            <div className="flex gap-2">
              <button disabled={busy || pick.chosen.size === 0 || diff < 0} className="bg-blue-600 text-white px-3 py-1 rounded-md disabled:opacity-50" onClick={() => { const p = pick; setPick(null); act(p.id, { action: 'deposit', orderIds: [...p.chosen] }); }}>Link {pick.chosen.size} order{pick.chosen.size === 1 ? '' : 's'}</button>
              <button className="text-gray-400" onClick={() => setPick(null)}>Cancel</button>
            </div>
          </div>
        );
      })()}

      {costFor && (
        <div className="border border-gray-700 rounded-md p-3 space-y-2 text-sm">
          <div className="font-medium text-white">Make a cost entry from row #{costFor.id}</div>
          <div className="text-xs text-gray-500">Uses the row's date, amount and description, paid from this account. The cost posts the expense; the row is linked as a cost and posts nothing itself.</div>
          <div className="flex flex-wrap gap-2">
            <select className="input" value={costFor.category} onChange={e => setCostFor({ ...costFor, category: e.target.value })}>{cats.map(k => <option key={k} value={k}>{k}</option>)}</select>
            <select className="input" value={costFor.business} onChange={e => setCostFor({ ...costFor, business: e.target.value })}><option value="resell">Resell</option><option value="shared">Shared</option></select>
            <button disabled={busy || !costFor.category} className="bg-blue-600 text-white px-3 py-1 rounded-md disabled:opacity-50" onClick={() => { const c = costFor; setCostFor(null); act(c.id, { action: 'cost', category: c.category, business: c.business }); }}>Create cost</button>
            <button className="text-gray-400" onClick={() => setCostFor(null)}>Cancel</button>
          </div>
        </div>
      )}

      {tab === 'txns' && <>
      <div className="space-y-2">
        <h2 className="text-sm font-medium text-white">Rules</h2>
        {rules.length === 0 ? <div className="text-xs text-gray-500">No rules yet. Use "Make a rule from this" on a transaction.</div> : (
          <Table head={['Matches', 'Account', 'Amount', 'Does', 'Hits', '']} rows={rules.map(r => [
            <span key="p" className={r.enabled ? '' : 'text-gray-500'}>{r.isRegex ? `/${r.pattern}/` : `"${r.pattern}"`} ({r.sign})</span>,
            r.bankAccountId ? (ov.accounts.find(a => a.id === r.bankAccountId)?.name ?? `#${r.bankAccountId}`) : 'any',
            r.minCents != null || r.maxCents != null ? `${r.minCents != null ? money(r.minCents) : ''} - ${r.maxCents != null ? money(r.maxCents) : ''}` : 'any',
            r.action.startsWith('transfer_to:') ? `transfer to ${ov.accounts.find(a => a.id === Number(r.action.slice(12)))?.name ?? r.action.slice(12)}` : `${r.action}${r.costCategory ? ` (${r.costCategory})` : ''}`,
            String(r.hits),
            <div key="x" className="flex gap-2 text-xs">
              <button className="text-blue-400" onClick={() => api(`/api/books/bank/rules/${r.id}`, 'PATCH', { enabled: !r.enabled }).then(load)}>{r.enabled ? 'Disable' : 'Enable'}</button>
              <button className="text-red-400" onClick={() => { if (confirm('Delete this rule? Rows it already matched stay matched.')) api(`/api/books/bank/rules/${r.id}`, 'DELETE').then(load); }}>Delete</button>
            </div>,
          ])} />
        )}
      </div>
      </>}

      {draft && (
        <div className="border border-gray-700 rounded-md p-3 space-y-2 text-sm">
          <div className="font-medium text-white">New rule</div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-gray-400 space-y-1"><span>Description contains</span><input className="input w-48" value={draft.pattern} onChange={e => setDraft({ ...draft, pattern: e.target.value })} /></label>
            <label className="text-xs text-gray-400 inline-flex items-center gap-1"><input type="checkbox" checked={draft.isRegex} onChange={e => setDraft({ ...draft, isRegex: e.target.checked })} />regex</label>
            <select className="input" value={draft.sign} onChange={e => setDraft({ ...draft, sign: e.target.value })}><option value="debit">Debits</option><option value="credit">Credits</option><option value="any">Either</option></select>
            <select className="input" value={draft.bankAccountId} onChange={e => setDraft({ ...draft, bankAccountId: e.target.value })}><option value="">Any account</option>{ov.accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
            <input className="input w-20" placeholder="min $" value={draft.min} onChange={e => setDraft({ ...draft, min: e.target.value })} />
            <input className="input w-20" placeholder="max $" value={draft.max} onChange={e => setDraft({ ...draft, max: e.target.value })} />
            <select className="input" value={draft.action} onChange={e => setDraft({ ...draft, action: e.target.value })}>
              <option value="personal">Personal</option><option value="ignore">Ignore (accounts not in your books)</option><option value="cost">Make a cost entry</option>
              <option value="darkbloom">Darkbloom payout</option><option value="cashback_portal">Portal cashback payment</option>
              {ov.accounts.map(a => <option key={a.id} value={`transfer_to:${a.id}`}>Transfer to {a.name}</option>)}
            </select>
            {draft.action === 'cost' && <>
              <select className="input" value={draft.costCategory} onChange={e => setDraft({ ...draft, costCategory: e.target.value })}>{cats.map(k => <option key={k} value={k}>{k}</option>)}</select>
              <select className="input" value={draft.business} onChange={e => setDraft({ ...draft, business: e.target.value })}><option value="resell">Resell</option><option value="shared">Shared</option></select>
            </>}
            <button disabled={busy || !draft.pattern.trim()} className="bg-blue-600 text-white px-3 py-1 rounded-md disabled:opacity-50" onClick={saveRule}>Save rule</button>
            <button className="text-gray-400" onClick={() => setDraft(null)}>Cancel</button>
          </div>
          <div className="text-xs text-gray-500">A rule acts on every open row it matches, now and after each sync, and is applied without asking. Undo on a row keeps that row out of the rules.</div>
        </div>
      )}
    </BooksShell>
  );
}
