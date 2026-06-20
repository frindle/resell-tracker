'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';

type PaymentStatus = 'all' | 'Waiting' | 'Sent' | 'Completed';

const STATUS_FILTERS: { value: PaymentStatus; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'Waiting', label: 'Waiting' },
  { value: 'Sent', label: 'Sent' },
  { value: 'Completed', label: 'Completed' },
];

const STATUS_STYLES: Record<string, string> = {
  Waiting: 'bg-yellow-900/50 text-yellow-300',
  Sent: 'bg-blue-900/50 text-blue-300',
  Completed: 'bg-green-900/50 text-green-300',
};

interface PaymentListing {
  amount: number;
  listing: {
    id: number;
    giftCard: { id: number };
    value: number;
    brand: { name: string };
    purchasePrice: number;
    paymentReceivedOn: string;
    purchasedAt: string;
  };
}

interface Payment {
  id?: number;
  name: string;
  amount: number;
  paymentMethod: string;
  status: string;
  date: string;
  receivedOn: string;
  paidBy: { id: number; displayName: string; email: string };
  paidTo?: { id: number; email: string };
  senderReconciled: boolean;
  recipientReconciled: boolean;
  listings?: PaymentListing[];
}

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function fmtDate(s: string) {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleDateString();
}

function PaymentDetail({ payment }: { payment: Payment }) {
  // Listings are pre-loaded with the payment list — no secondary fetch needed
  if (!payment.listings?.length) return <div className="px-6 py-3 text-gray-500 text-xs">No card details available.</div>;

  return (
    <div className="px-4 pb-3">
      <table className="w-full text-xs table-fixed">
        <colgroup>
          <col className="w-1/5" />
          <col className="w-1/5" />
          <col className="w-1/5" />
          <col className="w-1/5" />
          <col className="w-1/5" />
        </colgroup>
        <thead>
          <tr className="text-gray-500 border-b border-gray-800">
            <th className="py-1.5 pr-2 font-normal text-left">Brand</th>
            <th className="py-1.5 pr-2 font-normal text-left">Value</th>
            <th className="py-1.5 pr-2 font-normal text-left">Paid</th>
            <th className="py-1.5 pr-2 font-normal text-left">Submitted</th>
            <th className="py-1.5 font-normal text-left">Paid Date</th>
          </tr>
        </thead>
        <tbody>
          {payment.listings.map(l => (
            <tr key={l.listing.id} className="text-gray-300 border-b border-gray-800/30 last:border-0">
              <td className="py-1.5 pr-2 truncate">{l.listing.brand.name}</td>
              <td className="py-1.5 pr-2">{fmt(l.listing.value)}</td>
              <td className="py-1.5 pr-2">{fmt(l.amount)}</td>
              <td className="py-1.5 pr-2">{fmtDate(l.listing.purchasedAt)}</td>
              <td className="py-1.5">{fmtDate(l.listing.paymentReceivedOn)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function CardCenterPage() {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [status, setStatus] = useState<PaymentStatus>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async (s: PaymentStatus) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (s !== 'all') params.set('status', s);
      const res = await fetch(`/api/cardcenter/payments?${params}`);
      if (res.status === 400) { setError('CardCenter not configured. Add your credentials in Settings.'); return; }
      if (!res.ok) { setError(`Failed to load payments: ${await res.text()}`); return; }
      const data = await res.json() as { items: Payment[] };
      setPayments(data.items ?? []);
    } catch {
      setError('Network error.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(status); }, [status, load]);

  function toggleExpand(name: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  }

  const shown = payments;
  const totalShown = shown.reduce((s, p) => s + p.amount, 0);
  const pendingTotal = shown.filter(p => p.status === 'Waiting').reduce((s, p) => s + p.amount, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">CardCenter Payments</h1>
        <p className="text-gray-400 text-sm mt-1">
          {shown.length} payment{shown.length !== 1 ? 's' : ''}
          {shown.length > 0 && (
            <>
              {' '}· Total: <span className="text-green-400">{fmt(totalShown)}</span>
              {pendingTotal > 0 && <> · Waiting: <span className="text-yellow-400">{fmt(pendingTotal)}</span></>}
            </>
          )}
        </p>
      </div>

      <div className="flex gap-3 flex-wrap items-center">
        <div className="flex gap-1">
          {STATUS_FILTERS.map(f => (
            <button
              key={f.value}
              onClick={() => setStatus(f.value)}
              className={`px-3 py-1.5 rounded-md text-sm transition-colors ${status === f.value ? 'bg-blue-600 text-white' : 'bg-gray-900 border border-gray-700 text-gray-400 hover:text-white'}`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => load(status)}
          className="text-gray-500 hover:text-white text-sm transition-colors"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-900/20 px-4 py-3 text-sm text-red-300">
          {error}{' '}
          {error.includes('Settings') && (
            <Link href="/settings" className="underline hover:text-red-200">Go to Settings</Link>
          )}
        </div>
      )}

      {loading ? (
        <div className="text-center text-gray-500 py-12">Loading…</div>
      ) : shown.length === 0 && !error ? (
        <div className="rounded-lg border border-dashed border-gray-700 py-12 text-center text-gray-500">
          No payments found.
        </div>
      ) : (
        <div className="rounded-lg border border-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-900 text-gray-400 text-xs uppercase">
              <tr>
                <th className="px-4 py-2 w-6" />
                <th className="px-4 py-2 text-left">Status</th>
                <th className="px-4 py-2 text-left">Name</th>
                <th className="hidden sm:table-cell px-4 py-2 text-left">Buyer</th>
                <th className="px-4 py-2 text-right">Amount</th>
                <th className="px-4 py-2 text-left">Due</th>
                <th className="hidden lg:table-cell px-4 py-2 text-center">Reconciled</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {shown.map((p, i) => (
                <>
                  <tr
                    key={p.id ?? p.name ?? i}
                    className="hover:bg-gray-900/50 cursor-pointer"
                    onClick={() => toggleExpand(p.name)}
                  >
                    <td className="px-4 py-3 text-gray-500 text-xs">{expanded.has(p.name) ? '▾' : '▸'}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${STATUS_STYLES[p.status] ?? 'bg-gray-800 text-gray-400'}`}>
                        {p.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-300">{p.name}</td>
                    <td className="hidden sm:table-cell px-4 py-3 text-gray-400 text-xs">{p.paidBy?.displayName ?? '—'}</td>
                    <td className="px-4 py-3 text-right">
                      <span className={p.status === 'Completed' ? 'text-green-400' : p.status === 'Waiting' ? 'text-yellow-300' : 'text-blue-300'}>
                        {fmt(p.amount)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-300 text-xs">{fmtDate(p.receivedOn)}</td>
                    <td className="hidden lg:table-cell px-4 py-3 text-center text-xs">
                      {p.recipientReconciled ? <span className="text-green-400">✓</span> : <span className="text-gray-600">—</span>}
                    </td>
                  </tr>
                  {expanded.has(p.name) && (
                    <tr key={`${p.name}-detail`} className="bg-gray-900/30">
                      <td colSpan={7}>
                        <PaymentDetail payment={p} />
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
