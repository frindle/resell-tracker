'use client';

import { use, useEffect, useState } from 'react';

type Line = { key: string; label: string; amountCents: number; count: number; tokens: number };
type Cost = { key: string; label: string; amountCents: number | null };
type Payment = {
  payoutCents: number; allocatedCents: number; dueCents: number; status: string;
  deposits: { date: string; cents: number; requestedAt: string | null }[]; sentDate: string | null;
};
type Invoice = {
  copy?: number; finalCopy?: boolean; payment?: Payment; copies?: { copy: number; createdAt: string }[]; createdAt?: string;
  month: string; invoiceId: string; issueDate: string; currency: string; hash: string;
  grossCents: number; feesCents: number | null; feesNote: string | null; otherIncomeCents: number;
  lines: Line[]; costs: Cost[]; costsUnknown: string[]; netCents: number; machineCount: number;
  usage: { tokens: number | null; jobs: number | null; inferenceMinutes: number | null; sandboxMinutes: number | null; vcpuSeconds: number | null };
};

const money = (c: number) => (c < 0 ? '−' : '') + (Math.abs(c) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const num = (n: number | null) => (n == null ? 'not reported' : n.toLocaleString('en-US'));

// A printable mock invoice (Print or Save as PDF from the browser). The dark app chrome is hidden when printing.
export default function BloomInvoicePage({ params }: { params: Promise<{ month: string }> }) {
  const { month } = use(params);
  const [inv, setInv] = useState<Invoice | null>(null);
  const [err, setErr] = useState('');
  const [copies, setCopies] = useState<{ copy: number; createdAt: string }[]>([]);
  const [copy, setCopy] = useState<number | null>(null);

  // The copy list first; then the newest copy (the final one once the payment is matched) or, with none yet, the live invoice.
  useEffect(() => {
    fetch(`/api/bloom/invoices/${month}`)
      .then(async r => {
        if (!r.ok) return setErr((await r.json()).error ?? 'Not found');
        const live: Invoice = await r.json();
        setCopies(live.copies ?? []);
        if (live.copies?.length) setCopy(Math.max(...live.copies.map(c => c.copy))); else setInv(live);
      })
      .catch(() => setErr('Could not load the invoice'));
  }, [month]);
  useEffect(() => {
    if (copy == null) return;
    fetch(`/api/bloom/invoices/${month}?copy=${copy}`)
      .then(async r => (r.ok ? setInv(await r.json()) : setErr((await r.json()).error ?? 'Not found')))
      .catch(() => setErr('Could not load the copy'));
  }, [month, copy]);

  if (err) return <div className="text-sm text-red-400">{err}</div>;
  if (!inv) return <div className="text-gray-500 text-sm">Loading…</div>;
  const costs = inv.costs.filter(c => c.amountCents !== 0);
  return (
    <div className="space-y-4">
      <style>{`@media print { body { background: #fff !important; } nav, header, .no-print { display: none !important; } .invoice { color: #000 !important; background: #fff !important; border: 0 !important; } .invoice * { color: #000 !important; border-color: #999 !important; } }`}</style>
      <div className="no-print flex flex-wrap gap-3 items-center">
        <a href="/bloom" className="text-sm text-blue-400 hover:underline">All invoices</a>
        {copies.map(c => (
          <button key={c.copy} onClick={() => setCopy(c.copy)} aria-pressed={copy === c.copy}
            className={`text-sm px-3 py-1.5 rounded-md ${copy === c.copy ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-200 hover:bg-gray-700'}`}>
            {c.copy === 1 ? 'Copy 1 (first)' : 'Copy 2 (final)'} · {c.createdAt.slice(0, 10)}
          </button>
        ))}
        <button onClick={() => window.print()} className="text-sm px-3 py-1.5 rounded-md bg-gray-800 text-gray-200 hover:bg-gray-700">Print</button>
      </div>
      <div className="invoice rounded-lg border border-gray-800 bg-gray-900/40 p-6 space-y-5 max-w-2xl">
        <div className="flex justify-between items-start gap-4">
          <div>
            <h1 className="text-2xl font-bold">Invoice {inv.invoiceId}</h1>
            <p className="text-sm text-gray-400">Darkbloom earnings for {inv.month}, from Bloom Ledger</p>
          </div>
          <div className="text-sm text-gray-400 text-right">
            <p>Issued {inv.issueDate}</p>
            <p>{inv.machineCount} machine{inv.machineCount === 1 ? '' : 's'}</p>
          </div>
        </div>
        <table className="w-full text-sm">
          <thead className="text-gray-400 text-xs uppercase"><tr><th className="text-left py-1">Earnings</th><th className="text-right py-1">Jobs</th><th className="text-right py-1">Amount</th></tr></thead>
          <tbody className="divide-y divide-gray-800">
            {inv.lines.map(l => (
              <tr key={l.key}><td className="py-1.5">{l.label}</td><td className="py-1.5 text-right">{l.count ? l.count.toLocaleString('en-US') : ''}</td><td className="py-1.5 text-right">{money(l.amountCents)}</td></tr>
            ))}
            <tr className="font-medium"><td className="py-1.5" colSpan={2}>Gross earnings</td><td className="py-1.5 text-right">{money(inv.grossCents)}</td></tr>
            {inv.otherIncomeCents !== 0 && <tr><td className="py-1.5" colSpan={2}>Other income</td><td className="py-1.5 text-right">{money(inv.otherIncomeCents)}</td></tr>}
            <tr><td className="py-1.5" colSpan={2}>Darkbloom fees</td><td className="py-1.5 text-right">{inv.feesCents == null ? 'none' : money(-inv.feesCents)}</td></tr>
            {costs.map(c => (
              <tr key={c.key}><td className="py-1.5" colSpan={2}>{c.label}</td><td className="py-1.5 text-right">{c.amountCents == null ? 'not computed' : money(-c.amountCents)}</td></tr>
            ))}
            <tr className="font-bold text-base"><td className="py-2" colSpan={2}>Net</td><td className="py-2 text-right">{money(inv.netCents)}</td></tr>
          </tbody>
        </table>
        {inv.payment && (
          <div className="text-sm">
            <p className="text-gray-400 text-xs uppercase mb-1">Payment{inv.copy ? ` (copy ${inv.copy}${inv.finalCopy ? ', final' : ''})` : ''}</p>
            <p>Darkbloom payout {money(inv.payment.payoutCents)} · paid {money(inv.payment.allocatedCents)} · {inv.payment.status === 'nothing_due' ? 'nothing due' : `due ${money(inv.payment.dueCents)}`}</p>
            {inv.payment.deposits.map((d, i) => (
              <p key={i}>Deposit {d.date} for {money(d.cents)}{d.requestedAt ? `, request of ${d.requestedAt.slice(0, 10)}` : ', no matching request'}</p>
            ))}
            {inv.payment.sentDate && <p>Sent: {inv.payment.sentDate}</p>}
          </div>
        )}
        <div className="text-sm">
          <p className="text-gray-400 text-xs uppercase mb-1">Usage</p>
          <p>Tokens served: {num(inv.usage.tokens)} · Jobs: {num(inv.usage.jobs)}</p>
          <p>Inference minutes: {num(inv.usage.inferenceMinutes)} · Sandbox minutes: {num(inv.usage.sandboxMinutes)} · vCPU seconds: {num(inv.usage.vcpuSeconds)}</p>
        </div>
        <p className="text-xs text-gray-500">A mock invoice for bookkeeping, not a bill and not tax advice. {inv.feesNote ?? ''} Ledger hash {inv.hash.slice(0, 12)}.</p>
      </div>
    </div>
  );
}
