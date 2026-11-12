'use client';

import { useEffect, useState } from 'react';

type Entry = {
  id: number; kind: string; postedAt: string; interestCents: number; feeCents: number;
  principalCents: number; balanceCents: number | null; periodIndex: number | null; note: string | null;
};
type Row = {
  index: number | null; type: 'payment' | 'extra'; date: string; paymentCents: number; interestCents: number;
  principalCents: number; feeCents: number; balanceCents: number; recorded: boolean; entryId?: number;
};
type Loan = {
  id: number; kind: 'installment' | 'line' | 'card'; name: string; cardId: number | null;
  card: { id: number; name: string; last4: string | null } | null;
  principalCents: number; aprPercent: number | null; termMonths: number | null;
  startDate: string | null; firstPaymentDate: string | null; originationFeeCents: number;
  entries: Entry[];
  summary: {
    balanceCents: number | null; interestYtdCents: number; interestAllTimeCents: number;
    feesYtdCents: number; feesAllTimeCents: number; payoffDate: string | null; schedule: Row[];
  };
};
type Card = { id: number; name: string; last4: string | null };

const KIND_LABEL = { installment: 'Installment loan', line: 'Line of credit', card: 'Credit card balance' };
const money = (c: number | null) =>
  c == null ? '—' : (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const day = (iso: string) => iso.slice(0, 10);
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

async function send(url: string, method: string, body?: unknown): Promise<string | null> {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (r.ok) return null;
  try { return (await r.json()).error ?? 'Request failed'; } catch { return 'Request failed'; }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-xs text-gray-400 space-y-1"><span>{label}</span>{children}</label>;
}

/** Small inline form that POSTs one LoanEntry. */
function EntryForm({ loanId, entryId, kind, fields, submitLabel, extra, initial, onDone, onCancel }: {
  loanId: number; entryId?: number; kind: string; submitLabel: string;
  fields: ('postedAt' | 'interest' | 'fee' | 'principal' | 'balance')[];
  extra?: Record<string, unknown>; initial?: Record<string, string>;
  onDone: () => void; onCancel?: () => void;
}) {
  const [v, setV] = useState<Record<string, string>>({ postedAt: today(), ...initial });
  const [err, setErr] = useState('');
  const label = { postedAt: 'Date', interest: 'Interest $', fee: 'Fees $', principal: 'Principal $', balance: 'Balance $' };
  async function submit() {
    const e = entryId != null
      ? await send(`/api/loans/${loanId}/entries/${entryId}`, 'PATCH', { ...v })
      : await send(`/api/loans/${loanId}/entries`, 'POST', { kind, ...extra, ...v });
    if (e) setErr(e); else onDone();
  }
  return (
    <div className="flex flex-wrap items-end gap-2">
      {fields.map(f => (
        <Field key={f} label={label[f]}>
          <input className="input w-32" type={f === 'postedAt' ? 'date' : 'number'} step="0.01" min="0"
            value={v[f] ?? ''} onChange={e => setV({ ...v, [f]: e.target.value })} />
        </Field>
      ))}
      <button onClick={submit} className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-3 py-1.5 rounded-md">{submitLabel}</button>
      {onCancel && <button onClick={onCancel} className="text-sm text-gray-400 hover:text-white px-2 py-1.5">Cancel</button>}
      {err && <span className="text-red-400 text-xs">{err}</span>}
    </div>
  );
}

function LoanCard({ loan, cards, reload }: { loan: Loan; cards: Card[]; reload: () => void }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [editingLoan, setEditingLoan] = useState(false);
  const [editingEntry, setEditingEntry] = useState<number | null>(null);
  const s = loan.summary;
  const inst = loan.kind === 'installment';

  async function del() {
    if (!confirm(`Delete "${loan.name}" and all of its entries? This cannot be undone.`)) return;
    await send(`/api/loans/${loan.id}`, 'DELETE');
    reload();
  }
  async function delEntry(entryId: number) {
    await send(`/api/loans/${loan.id}/entries/${entryId}`, 'DELETE');
    reload();
  }
  const done = () => { setEditing(null); setEditingEntry(null); setEditingLoan(false); reload(); };
  const entryInitial = (e: Entry) => ({
    postedAt: day(e.postedAt), interest: (e.interestCents / 100).toFixed(2), fee: (e.feeCents / 100).toFixed(2),
    principal: (e.principalCents / 100).toFixed(2), balance: e.balanceCents == null ? '' : (e.balanceCents / 100).toFixed(2),
  });
  const entryEditor = (e: Entry, fields: ('postedAt' | 'interest' | 'fee' | 'principal' | 'balance')[]) => (
    <EntryForm loanId={loan.id} entryId={e.id} kind={e.kind} fields={fields} submitLabel="Save" initial={entryInitial(e)} onDone={done} onCancel={() => setEditingEntry(null)} />
  );

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/40 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold">{loan.name}</p>
          <p className="text-xs text-gray-500">
            {KIND_LABEL[loan.kind]}
            {loan.card && ` · ${loan.card.name}${loan.card.last4 ? ` ••${loan.card.last4}` : ''}`}
            {inst && ` · ${money(loan.principalCents)} at ${loan.aprPercent ?? 0}% for ${loan.termMonths} mo`}
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button onClick={() => setEditingLoan(!editingLoan)} className="text-sm text-blue-400 hover:text-blue-300 px-2 py-1">Edit</button>
          <button onClick={() => setOpen(!open)} className="text-sm text-gray-300 hover:text-white bg-gray-800 border border-gray-700 px-2.5 py-1 rounded-md">{open ? 'Hide' : 'Details'}</button>
          <button onClick={del} className="text-sm text-red-400 hover:text-red-300 px-2 py-1">Delete</button>
        </div>
      </div>

      {editingLoan && <LoanForm loan={loan} cards={cards} onDone={done} onCancel={() => setEditingLoan(false)} />}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <div><p className="text-xs text-gray-500">Balance left</p><p className="font-semibold">{money(s.balanceCents)}</p></div>
        <div><p className="text-xs text-gray-500">Interest this year</p><p className="font-semibold">{money(s.interestYtdCents)}</p></div>
        <div><p className="text-xs text-gray-500">Interest all time</p><p className="font-semibold">{money(s.interestAllTimeCents)}</p></div>
        {inst
          ? <div><p className="text-xs text-gray-500">Payoff date</p><p className="font-semibold">{s.payoffDate ? day(s.payoffDate) : '—'}</p></div>
          : <div><p className="text-xs text-gray-500">Fees all time</p><p className="font-semibold">{money(s.feesAllTimeCents)}</p></div>}
      </div>

      {open && inst && (
        <div className="space-y-3">
          <div className="overflow-x-auto rounded-md border border-gray-800">
            <table className="w-full text-xs">
              <thead className="bg-gray-900 text-gray-400 uppercase">
                <tr>
                  <th className="px-2 py-1.5 text-left">#</th><th className="px-2 py-1.5 text-left">Date</th>
                  <th className="px-2 py-1.5 text-right">Payment</th><th className="px-2 py-1.5 text-right">Interest</th>
                  <th className="px-2 py-1.5 text-right">Principal</th><th className="px-2 py-1.5 text-right">Fees</th>
                  <th className="px-2 py-1.5 text-right">Balance</th><th className="px-2 py-1.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {s.schedule.map((r, i) => (
                  <tr key={i} className={new Date(r.date) > new Date() ? 'text-gray-500' : 'text-gray-200'}>
                    <td className="px-2 py-1">{r.type === 'extra' ? 'Extra' : r.index}</td>
                    <td className="px-2 py-1">{day(r.date)}{r.recorded && r.type === 'payment' ? ' *' : ''}</td>
                    <td className="px-2 py-1 text-right">{money(r.paymentCents)}</td>
                    <td className="px-2 py-1 text-right">{money(r.interestCents)}</td>
                    <td className="px-2 py-1 text-right">{money(r.principalCents)}</td>
                    <td className="px-2 py-1 text-right">{r.feeCents ? money(r.feeCents) : '—'}</td>
                    <td className="px-2 py-1 text-right">{money(r.balanceCents)}</td>
                    <td className="px-2 py-1 text-right whitespace-nowrap">
                      {r.type === 'payment' && editing !== r.index && (
                        <button onClick={() => setEditing(r.index)} className="text-blue-400 hover:text-blue-300 mr-2">Change</button>
                      )}
                      {r.type === 'extra' && r.entryId != null && editingEntry !== r.entryId && (
                        <button onClick={() => setEditingEntry(r.entryId!)} className="text-blue-400 hover:text-blue-300 mr-2">Edit</button>
                      )}
                      {r.entryId != null && (
                        <button onClick={() => delEntry(r.entryId!)} className="text-red-400 hover:text-red-300">{r.type === 'extra' ? 'Delete' : 'Reset'}</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-gray-500">Scheduled payments count as made on their date. * = you entered the real numbers, which replace the schedule.{loan.originationFeeCents > 0 && ` Origination fee ${money(loan.originationFeeCents)} counts on the funding date.`}</p>
          {editing != null && (() => {
            const r = s.schedule.find(x => x.type === 'payment' && x.index === editing);
            return r ? (
              <div className="space-y-1">
                <p className="text-xs text-gray-400">Real numbers for payment {editing}</p>
                <EntryForm loanId={loan.id} kind="payment" extra={{ periodIndex: editing }} submitLabel="Save payment"
                  fields={['postedAt', 'interest', 'fee', 'principal']}
                  initial={{ postedAt: day(r.date), interest: (r.interestCents / 100).toFixed(2), fee: (r.feeCents / 100).toFixed(2), principal: (r.principalCents / 100).toFixed(2) }}
                  onDone={done} onCancel={() => setEditing(null)} />
              </div>
            ) : null;
          })()}
          {editingEntry != null && (() => {
            const e = loan.entries.find(x => x.id === editingEntry);
            return e && e.kind === 'extra_payment' ? (
              <div className="space-y-1"><p className="text-xs text-gray-400">Edit extra payment</p>{entryEditor(e, ['postedAt', 'interest', 'fee', 'principal'])}</div>
            ) : null;
          })()}
          <div className="space-y-1">
            <p className="text-xs text-gray-400">Extra payment (shortens the rest of the schedule)</p>
            <EntryForm loanId={loan.id} kind="extra_payment" fields={['postedAt', 'principal']} submitLabel="Add extra payment" onDone={reload} />
          </div>
          <div className="space-y-1">
            <p className="text-xs text-gray-400">Late fee or other fee</p>
            <EntryForm loanId={loan.id} kind="fee" fields={['postedAt', 'fee']} submitLabel="Add fee" onDone={reload} />
          </div>
          {loan.entries.filter(e => e.kind === 'fee').map(e => (
            editingEntry === e.id ? <div key={e.id}>{entryEditor(e, ['postedAt', 'fee'])}</div> : (
              <p key={e.id} className="text-xs text-gray-400">Fee {day(e.postedAt)}: {money(e.feeCents + e.interestCents)}{' '}
                <button onClick={() => setEditingEntry(e.id)} className="text-blue-400 hover:text-blue-300 mr-2">Edit</button>
                <button onClick={() => delEntry(e.id)} className="text-red-400 hover:text-red-300">Delete</button></p>
            )
          ))}
        </div>
      )}

      {open && !inst && (
        <div className="space-y-3">
          <div className="overflow-x-auto rounded-md border border-gray-800">
            <table className="w-full text-xs">
              <thead className="bg-gray-900 text-gray-400 uppercase">
                <tr><th className="px-2 py-1.5 text-left">Date</th><th className="px-2 py-1.5 text-left">Type</th>
                  <th className="px-2 py-1.5 text-right">Interest</th><th className="px-2 py-1.5 text-right">Fees</th>
                  <th className="px-2 py-1.5 text-right">Balance</th><th className="px-2 py-1.5" /></tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {[...loan.entries].reverse().map(e => (
                  <tr key={e.id}>
                    <td className="px-2 py-1">{day(e.postedAt)}</td>
                    <td className="px-2 py-1">{e.kind === 'statement' ? 'Statement' : 'Fee'}</td>
                    <td className="px-2 py-1 text-right">{money(e.interestCents)}</td>
                    <td className="px-2 py-1 text-right">{e.feeCents ? money(e.feeCents) : '—'}</td>
                    <td className="px-2 py-1 text-right">{money(e.balanceCents)}</td>
                    <td className="px-2 py-1 text-right whitespace-nowrap">
                      <button onClick={() => setEditingEntry(e.id)} className="text-blue-400 hover:text-blue-300 mr-2">Edit</button>
                      <button onClick={() => delEntry(e.id)} className="text-red-400 hover:text-red-300">Delete</button>
                    </td>
                  </tr>
                ))}
                {loan.entries.length === 0 && <tr><td colSpan={6} className="px-2 py-3 text-gray-500">No statements yet.</td></tr>}
              </tbody>
            </table>
          </div>
          {editingEntry != null && (() => {
            const e = loan.entries.find(x => x.id === editingEntry);
            return e ? (
              <div className="space-y-1"><p className="text-xs text-gray-400">Edit {e.kind === 'statement' ? 'statement' : 'fee'}</p>
                {entryEditor(e, e.kind === 'statement' ? ['postedAt', 'interest', 'fee', 'balance'] : ['postedAt', 'fee'])}</div>
            ) : null;
          })()}
          <div className="space-y-1">
            <p className="text-xs text-gray-400">Statement (a month with no interest is a statement with $0)</p>
            <EntryForm loanId={loan.id} kind="statement" fields={['postedAt', 'interest', 'fee', 'balance']} submitLabel="Add statement" onDone={reload} />
          </div>
          <div className="space-y-1">
            <p className="text-xs text-gray-400">Stand-alone fee (annual fee, for example)</p>
            <EntryForm loanId={loan.id} kind="fee" fields={['postedAt', 'fee']} submitLabel="Add fee" onDone={reload} />
          </div>
        </div>
      )}
    </div>
  );
}

/** Create a loan, or (with `loan`) edit one: PATCH, same validation server-side. Kind is fixed once created. */
function LoanForm({ loan, cards, onDone, onCancel }: { loan?: Loan; cards: Card[]; onDone: () => void; onCancel?: () => void }) {
  const [kind, setKind] = useState<Loan['kind']>(loan?.kind ?? 'installment');
  const [v, setV] = useState<Record<string, string>>(loan ? {
    name: loan.name, cardId: loan.cardId != null ? String(loan.cardId) : '',
    amount: loan.kind === 'installment' ? (loan.principalCents / 100).toFixed(2) : '',
    aprPercent: loan.aprPercent != null ? String(loan.aprPercent) : '', termMonths: loan.termMonths != null ? String(loan.termMonths) : '',
    firstPaymentDate: loan.firstPaymentDate ? day(loan.firstPaymentDate) : '', startDate: loan.startDate ? day(loan.startDate) : '',
    originationFee: loan.originationFeeCents ? (loan.originationFeeCents / 100).toFixed(2) : '',
  } : {});
  const [err, setErr] = useState('');
  const set = (k: string, val: string) => setV({ ...v, [k]: val });
  async function save() {
    const e = loan ? await send(`/api/loans/${loan.id}`, 'PATCH', { ...v }) : await send('/api/loans', 'POST', { kind, ...v });
    if (e) { setErr(e); return; }
    if (!loan) setV({});
    setErr(''); onDone();
  }
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/40 p-4 space-y-3">
      <p className="text-sm font-medium text-gray-300">{loan ? 'Edit loan' : 'Add a loan'}</p>
      {!loan && <div className="flex flex-wrap gap-2">
        {(Object.keys(KIND_LABEL) as Loan['kind'][]).map(k => (
          <button key={k} onClick={() => setKind(k)}
            className={`text-sm px-3 py-1.5 rounded-md ${kind === k ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>{KIND_LABEL[k]}</button>
        ))}
      </div>}
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Name"><input className="input w-44" value={v.name ?? ''} onChange={e => set('name', e.target.value)} /></Field>
        {kind === 'card' && (
          <Field label="Card">
            <select className="input w-52" value={v.cardId ?? ''} onChange={e => set('cardId', e.target.value)}>
              <option value="">Select a card</option>
              {cards.map(c => <option key={c.id} value={c.id}>{c.name}{c.last4 ? ` ••${c.last4}` : ''}</option>)}
            </select>
          </Field>
        )}
        {kind === 'installment' && (
          <>
            <Field label="Amount $"><input className="input w-28" type="number" step="0.01" value={v.amount ?? ''} onChange={e => set('amount', e.target.value)} /></Field>
            <Field label="APR %"><input className="input w-24" type="number" step="0.01" value={v.aprPercent ?? ''} onChange={e => set('aprPercent', e.target.value)} /></Field>
            <Field label="Months"><input className="input w-20" type="number" value={v.termMonths ?? ''} onChange={e => set('termMonths', e.target.value)} /></Field>
            <Field label="First payment"><input className="input w-36" type="date" value={v.firstPaymentDate ?? ''} onChange={e => set('firstPaymentDate', e.target.value)} /></Field>
            <Field label="Funded on (optional)"><input className="input w-36" type="date" value={v.startDate ?? ''} onChange={e => set('startDate', e.target.value)} /></Field>
            <Field label="Fee at start $"><input className="input w-24" type="number" step="0.01" value={v.originationFee ?? ''} onChange={e => set('originationFee', e.target.value)} /></Field>
          </>
        )}
        <button onClick={save} className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-3 py-1.5 rounded-md">{loan ? 'Save' : 'Add'}</button>
        {onCancel && <button onClick={onCancel} className="text-sm text-gray-400 hover:text-white px-2 py-1.5">Cancel</button>}
      </div>
      {err && <p className="text-red-400 text-xs">{err}</p>}
    </div>
  );
}

export default function LoansPage() {
  const [loans, setLoans] = useState<Loan[] | null>(null);
  const [cards, setCards] = useState<Card[]>([]);

  function load() {
    fetch('/api/loans').then(r => r.json()).then(setLoans);
  }
  useEffect(() => {
    load();
    fetch('/api/cards').then(r => r.json()).then(setCards).catch(() => {});
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Loans</h1>
        <p className="text-gray-400 text-sm mt-1">Interest and fees come off reselling profit on the date they post. Borrowed money is not income and paying it back is not a cost. Bookkeeping estimates, not tax advice.</p>
      </div>
      <LoanForm cards={cards} onDone={load} />
      {loans === null && <p className="text-gray-500 text-sm">Loading…</p>}
      {loans?.length === 0 && <p className="text-gray-500 text-sm">No loans yet.</p>}
      {loans?.map(l => <LoanCard key={l.id} loan={l} cards={cards} reload={load} />)}
    </div>
  );
}
