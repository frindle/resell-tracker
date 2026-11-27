'use client';

import { useCallback, useEffect, useState } from 'react';
import { BooksShell, Off, Table, api, money } from '../ui';

type Row = { code: string; name: string; cents: number };
type Bs = { asOf: string; assets: Row[]; liabilities: Row[]; equity: Row[]; totalAssetsCents: number; totalLiabilitiesCents: number; totalEquityCents: number; differenceCents: number };
type Cf = { months: { month: string; beginCents: number; operatingCents: number; investingCents: number; financingCents: number; openingCents: number; netCents: number; endCents: number }[]; cashBalanceCents: number; differenceCents: number };
type Inv = { lots: { orderId: number | null; label: string; acquired: string; ageDays: number; bucket: string; valueCents: number }[]; buckets: { bucket: string; lots: number; valueCents: number }[]; totalCents: number; accountBalanceCents: number; differenceCents: number };
type Sc = { business: string; year: number; line1Cents: number; line2Cents: number; line3Cents: number; line4Cents: number; line5Cents: number; line6Cents: number; line7Cents: number; expenses: { line: string; label: string; cents: number }[]; line28Cents: number; line31Cents: number; partIII: { beginInventoryCents: number; purchasesCents: number; endInventoryCents: number; cogsCents: number }; sharedIncludedCents: number; notes: string[] };

// Only well-formed values reach a URL: a date (YYYY-MM-DD) and a four-digit year, both encoded.
const cleanDate = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '');
const cleanYear = (v: string) => (/^\d{4}$/.test(v) ? v : '');
const qs = (params: Record<string, string>) => Object.entries(params).filter(([, v]) => v).map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join('');
const dl = (type: string, params: Record<string, string> = {}) => `/api/books/reports?type=${encodeURIComponent(type)}&format=csv${qs(params)}`;
const Csv = ({ href, label = 'CSV' }: { href: string; label?: string }) => <a className="text-xs underline text-blue-400" href={href}>{label}</a>;

export default function ReportsPage() {
  const thisYear = String(new Date().getFullYear());
  const [off, setOff] = useState(false);
  const [asOf, setAsOf] = useState(''); // empty = today (the server uses the Los Angeles day)
  const [year, setYear] = useState(thisYear);
  const [bs, setBs] = useState<Bs | null>(null);
  const [cf, setCf] = useState<Cf | null>(null);
  const [inv, setInv] = useState<Inv | null>(null);
  const [sc, setSc] = useState<{ resell: Sc; darkbloom: Sc } | null>(null);

  const load = useCallback(async () => {
    const q = qs({ asOf: cleanDate(asOf), year: cleanYear(year) });
    const [a, b, c, d] = await Promise.all([
      api<Bs>(`/api/books/reports?type=balance-sheet${q}`), api<Cf>('/api/books/reports?type=cash-flow'), api<Inv>(`/api/books/reports?type=inventory${q}`),
      api<{ resell: Sc; darkbloom: Sc }>(`/api/books/reports?type=schedule-c${q}`),
    ]);
    if (!a.ok) { setOff(true); return; }
    setBs(a.data); if (b.ok) setCf(b.data); if (c.ok) setInv(c.data); if (d.ok) setSc(d.data);
  }, [asOf, year]);
  useEffect(() => { const t = setTimeout(load, 0); return () => clearTimeout(t); }, [load]);

  if (off) return <BooksShell title="Reports"><Off /></BooksShell>;
  if (!bs) return <BooksShell title="Reports"><div className="text-sm text-gray-500">Loading...</div></BooksShell>;
  const section = (rows: Row[], total: number, label: string) => [
    ...rows.map(r => [r.code, r.name, money(r.cents)]),
    [<b key="t">{label}</b>, '', <b key="v">{money(total)}</b>],
  ];
  return (
    <BooksShell title="Reports">
      <div className="flex flex-wrap items-end gap-3 text-xs text-gray-400">
        <label className="space-y-1"><span>As of</span><input type="date" className="input" value={asOf} onChange={e => setAsOf(e.target.value)} /></label>
        <label className="space-y-1"><span>Tax year</span><input className="input w-24" value={year} onChange={e => setYear(e.target.value)} /></label>
        <Csv href="/api/books/reports?type=beancount" label="Beancount export (independent check)" />
        <Csv href="/api/books/reports?type=journal&format=csv" label="Journal CSV" />
        <Csv href={dl('trial', { asOf: cleanDate(asOf) })} label="Trial balance CSV" />
        <Csv href={dl('pnl')} label="Profit and loss CSV" />
      </div>

      <section className="space-y-2">
        <div className="flex gap-3 items-center"><h2 className="text-sm font-medium text-gray-300">Balance sheet as of {bs.asOf}</h2><Csv href={dl('balance-sheet', { asOf: cleanDate(asOf) })} /></div>
        <Table head={['Code', 'Account', 'Balance']} rows={[
          ...section(bs.assets, bs.totalAssetsCents, 'Total assets'),
          ...section(bs.liabilities, bs.totalLiabilitiesCents, 'Total liabilities'),
          ...section(bs.equity, bs.totalEquityCents, 'Total equity'),
        ]} />
        {bs.differenceCents !== 0 && <div className="text-xs text-red-400">Assets differ from liabilities plus equity by {money(bs.differenceCents)}.</div>}
      </section>

      <section className="space-y-2">
        <div className="flex gap-3 items-center"><h2 className="text-sm font-medium text-gray-300">Cash flow by month</h2><Csv href={dl('cash-flow')} /></div>
        <p className="text-xs text-gray-500">Cash = bank and cash accounts (codes 1000-1099). Transfers between them net out.</p>
        <Table head={['Month', 'Begin', 'Operating', 'Investing', 'Financing', 'Opening balances', 'Net', 'End']} rows={(cf?.months ?? []).map(m => [m.month, money(m.beginCents), money(m.operatingCents), money(m.investingCents), money(m.financingCents), money(m.openingCents), money(m.netCents), money(m.endCents)])} />
        {cf && cf.differenceCents !== 0 && <div className="text-xs text-red-400">The last month&apos;s ending cash differs from the ledger&apos;s cash balance by {money(cf.differenceCents)}.</div>}
      </section>

      <section className="space-y-2">
        <div className="flex gap-3 items-center"><h2 className="text-sm font-medium text-gray-300">Inventory on hand, by order (specific ID)</h2><Csv href={dl('inventory', { asOf: cleanDate(asOf) })} /></div>
        {inv && <>
          <div className="text-sm text-gray-200">Lots total {money(inv.totalCents)}; inventory accounts {money(inv.accountBalanceCents)}{inv.differenceCents !== 0 && <span className="text-red-400"> (differ by {money(inv.differenceCents)})</span>}</div>
          <Table head={['Age (days)', 'Lots', 'Value']} rows={inv.buckets.map(b => [b.bucket, b.lots, money(b.valueCents)])} />
          <Table head={['Order', 'Item', 'Acquired', 'Age', 'Value']} rows={inv.lots.map(l => [l.orderId == null ? 'no order' : `#${l.orderId}`, l.label, l.acquired, `${l.ageDays}d`, money(l.valueCents)])} />
        </>}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-gray-300">Schedule C worksheet, {year}</h2>
        <div className="text-xs border border-amber-700 bg-amber-950/30 text-amber-200 rounded-md p-2">Estimate for your CPA to review. Not tax advice and not a filed return.</div>
        {sc && (['resell', 'darkbloom'] as const).map(b => {
          const s = sc[b];
          return (
            <div key={b} className="space-y-1">
              <div className="flex gap-3 items-center"><h3 className="text-sm text-gray-200">{b === 'resell' ? 'Resell' : 'Darkbloom'}</h3><Csv href={dl('schedule-c', { year: cleanYear(year), business: b })} /></div>
              <Table head={['Line', 'Description', 'Amount']} rows={[
                ['1', 'Gross receipts or sales', money(s.line1Cents)], ['2', 'Returns and allowances', money(s.line2Cents)], ['3', 'Line 1 minus line 2', money(s.line3Cents)],
                ['4', 'Cost of goods sold', money(s.line4Cents)], ['5', 'Gross profit', money(s.line5Cents)], ['6', 'Other income', money(s.line6Cents)], ['7', 'Gross income', money(s.line7Cents)],
                ...s.expenses.map(e => [e.line, e.label, money(e.cents)]),
                ['28', 'Total expenses', money(s.line28Cents)], ['31', 'Net profit or loss', money(s.line31Cents)],
                ['35', 'Part III: inventory at start of year', money(s.partIII.beginInventoryCents)], ['36', 'Part III: purchases (derived)', money(s.partIII.purchasesCents)], ['41', 'Part III: inventory at end of year', money(s.partIII.endInventoryCents)],
              ]} />
              <ul className="text-xs text-gray-500 list-disc pl-5">{s.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
            </div>
          );
        })}
      </section>
    </BooksShell>
  );
}
