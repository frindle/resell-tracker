'use client';

import { useEffect, useState } from 'react';
import { BooksShell, Off, Table, api, money } from '../ui';

type Parity = {
  goLive: string; counts: { match: number; mismatch: number; timing: number };
  rows: { orderId: number; platform: string; status: string; expectedCents: number; actualCents: number; diffCents: number; knownCents: number; note: string }[];
  period: { month: string; analyticsCents: number; booksCents: number; diffCents: number }[];
};

export default function ParityPage() {
  const [p, setP] = useState<Parity | null>(null);
  const [off, setOff] = useState(false);
  useEffect(() => { api<Parity>('/api/books/parity').then(r => (r.ok ? setP(r.data as Parity) : setOff(true))); }, []);
  if (off) return <BooksShell title="Parity"><Off /></BooksShell>;
  if (!p) return <BooksShell title="Parity"><div className="text-sm text-gray-500">Loading...</div></BooksShell>;
  const bad = p.rows.filter(r => r.status === 'mismatch');
  const known = p.rows.filter(r => r.knownCents !== 0);
  return (
    <BooksShell title="Parity with Analytics">
      <p className="text-sm text-gray-400">For orders dated on or after {p.goLive}: the books' income, returns, and cost-of-goods lines should equal the profit shown in Analytics, to the cent. Unsold orders and returns in flight are timing differences, not errors. Sign convention: books lines are credit-negative, so expected = minus profit.</p>
      <div className="text-sm text-gray-200">{p.counts.match} match, <span className={p.counts.mismatch ? 'text-red-400' : ''}>{p.counts.mismatch} mismatch</span>, {p.counts.timing} timing</div>
      <h2 className="text-sm font-medium text-gray-300">Mismatches</h2>
      <Table head={['Order', 'Platform', 'Expected', 'Books', 'Difference']} rows={bad.map(r => [`#${r.orderId}`, r.platform, money(r.expectedCents), money(r.actualCents), money(r.diffCents)])} />
      <h2 className="text-sm font-medium text-gray-300">Known differences (tagged shortfalls and refund-vs-basis)</h2>
      <Table head={['Order', 'Platform', 'Tagged amount', 'Note']} rows={known.map(r => [`#${r.orderId}`, r.platform, money(r.knownCents), r.note])} />
      <h2 className="text-sm font-medium text-gray-300">By month: Analytics (order date) vs books (event date)</h2>
      <Table head={['Month', 'Analytics', 'Books', 'Timing difference']} rows={p.period.map(r => [r.month, money(r.analyticsCents), money(r.booksCents), money(r.diffCents)])} />
    </BooksShell>
  );
}
