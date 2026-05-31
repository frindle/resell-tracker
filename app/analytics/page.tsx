'use client';

import { useEffect, useState } from 'react';
import type { PeriodKey } from '@/lib/analytics';

const PERIOD_LABELS: Record<PeriodKey, string> = {
  current_month:   'This Month',
  last_month:      'Last Month',
  current_quarter: 'This Quarter',
  last_quarter:    'Last Quarter',
  ytd:             'Year to Date',
  last_year:       'Last Year',
};

const PERIODS = Object.keys(PERIOD_LABELS) as PeriodKey[];

type Stats = { revenue: number; cost: number; cashback: number; profit: number; orderCount: number; miles: number; milesByProgram: Record<string, number> };
type PeriodResult = { period: PeriodKey; label: string; current: Stats; comparison: Stats };
type MonthBucket = { month: string; revenue: number; cost: number; cashback: number; profit: number; miles: number; count: number };

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

function fmtExact(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function pct(current: number, prior: number) {
  if (!prior) return null;
  return ((current - prior) / Math.abs(prior)) * 100;
}

function Delta({ current, prior }: { current: number; prior: number }) {
  const p = pct(current, prior);
  if (p === null) return <span className="text-gray-600 text-xs">no prior data</span>;
  const up = p >= 0;
  return (
    <span className={`text-xs font-medium ${up ? 'text-green-400' : 'text-red-400'}`}>
      {up ? '▲' : '▼'} {Math.abs(p).toFixed(1)}% vs prior year
    </span>
  );
}

function StatCard({ label, value, prior, accent }: { label: string; value: number; prior: number; accent?: boolean }) {
  return (
    <div className={`rounded-lg border p-4 space-y-1 ${accent ? 'border-blue-700 bg-blue-950/30' : 'border-gray-800 bg-gray-900/40'}`}>
      <p className="text-gray-400 text-xs uppercase tracking-wide">{label}</p>
      <p className={`text-2xl font-bold ${accent ? 'text-blue-300' : 'text-white'}`}>{fmt(value)}</p>
      <div className="flex items-center gap-2">
        <Delta current={value} prior={prior} />
        {prior !== 0 && (
          <span className="text-gray-600 text-xs">(prior: {fmt(prior)})</span>
        )}
      </div>
    </div>
  );
}

function fmtShort(n: number) {
  const abs = Math.abs(n);
  const s = abs >= 1000 ? `$${(abs / 1000).toFixed(1)}k` : `$${abs.toFixed(0)}`;
  return n < 0 ? `-${s}` : s;
}

// Simple CSS bar chart — no external deps
function MonthChart({ months }: { months: MonthBucket[] }) {
  if (!months.length) return null;
  const maxProfit = Math.max(...months.map(m => Math.abs(m.profit)), 1);

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-gray-300">Monthly Profit — last 12 months</p>
      <div className="flex items-end gap-1" style={{ height: '160px' }}>
        {months.map(m => {
          const h = Math.round((Math.abs(m.profit) / maxProfit) * 72);
          const pos = m.profit >= 0;
          const mon = new Date(m.month + '-02').toLocaleString('default', { month: 'short' });
          return (
            <div key={m.month} className="flex-1 flex flex-col items-center justify-end gap-0.5 group" title={`${m.month}: ${fmtExact(m.profit)} profit, ${m.count} orders`}>
              <span className={`text-xs font-medium leading-none ${pos ? 'text-blue-400' : 'text-red-400'}`} style={{ fontSize: '10px' }}>
                {fmtShort(m.profit)}
              </span>
              <div
                className={`w-full rounded-t transition-all ${pos ? 'bg-blue-600 group-hover:bg-blue-500' : 'bg-red-700 group-hover:bg-red-600'}`}
                style={{ height: `${Math.max(h, 3)}px` }}
              />
              <span className="text-gray-500 leading-none" style={{ fontSize: '10px' }}>{mon}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function AnalyticsPage() {
  const [data, setData] = useState<{ periods: PeriodResult[]; monthly: MonthBucket[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [activePeriod, setActivePeriod] = useState<PeriodKey>('current_month');

  useEffect(() => {
    fetch('/api/analytics')
      .then(r => r.json())
      .then(setData)
      .finally(() => setLoading(false));
  }, []);

  const active = data?.periods.find(p => p.period === activePeriod);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Profit Analytics</h1>
        <p className="text-gray-400 text-sm mt-1">All figures include cashback. Profit = Sale − Cost − Shipping + Cashback.</p>
      </div>

      {/* Period selector */}
      <div className="flex flex-wrap gap-2">
        {PERIODS.map(p => (
          <button key={p} onClick={() => setActivePeriod(p)}
            className={`text-sm px-3 py-1.5 rounded-md transition-colors ${
              activePeriod === p
                ? 'bg-blue-600 text-white'
                : 'bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700'
            }`}>
            {PERIOD_LABELS[p]}
          </button>
        ))}
      </div>

      {loading && <div className="text-gray-500 text-sm py-8 text-center">Loading…</div>}

      {active && (
        <>
          {/* Key metrics */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            <StatCard accent label="Profit" value={active.current.profit} prior={active.comparison.profit} />
            <StatCard label="Revenue" value={active.current.revenue} prior={active.comparison.revenue} />
            <StatCard label="Cost" value={active.current.cost} prior={active.comparison.cost} />
            <StatCard label="Cashback" value={active.current.cashback} prior={active.comparison.cashback} />
            <div className="rounded-lg border border-gray-800 bg-gray-900/40 p-4 space-y-1">
              <p className="text-gray-400 text-xs uppercase tracking-wide">Orders</p>
              <p className="text-2xl font-bold text-white">{active.current.orderCount}</p>
              <Delta current={active.current.orderCount} prior={active.comparison.orderCount} />
            </div>
            {active.current.miles > 0 && (() => {
              const programs = Object.entries(active.current.milesByProgram)
                .sort(([, a], [, b]) => b - a)
                .slice(0, 3);
              return (
                <div className="rounded-lg border border-purple-900/50 bg-purple-950/20 p-4 space-y-2">
                  <p className="text-gray-400 text-xs uppercase tracking-wide">Est. Miles / Pts</p>
                  {programs.length > 0 ? programs.map(([prog, pts]) => (
                    <div key={prog} className="flex items-baseline justify-between gap-2">
                      <span className="text-gray-400 text-xs truncate">{prog}</span>
                      <span className="text-purple-300 font-semibold text-sm shrink-0">{pts.toLocaleString()}</span>
                    </div>
                  )) : (
                    <p className="text-purple-300 font-bold text-2xl">{active.current.miles.toLocaleString()}</p>
                  )}
                </div>
              );
            })()}
          </div>

          {/* Comparison table */}
          <div className="rounded-lg border border-gray-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-900 text-gray-400 text-xs uppercase">
                <tr>
                  <th className="px-4 py-2 text-left">Metric</th>
                  <th className="px-4 py-2 text-right">{PERIOD_LABELS[activePeriod]}</th>
                  <th className="hidden sm:table-cell px-4 py-2 text-right">Same Period Last Year</th>
                  <th className="px-4 py-2 text-right">Change</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {([
                  ['Profit',      active.current.profit,      active.comparison.profit,      'currency', false],
                  ['Revenue',     active.current.revenue,     active.comparison.revenue,     'currency', false],
                  ['Cost',        active.current.cost,        active.comparison.cost,        'currency', true],
                  ['Cashback',    active.current.cashback,    active.comparison.cashback,    'currency', false],
                  ['Orders',      active.current.orderCount,  active.comparison.orderCount,  'int',      false],
                  ...(Object.keys({ ...active.current.milesByProgram, ...active.comparison.milesByProgram }).length > 0
                    ? Object.keys({ ...active.current.milesByProgram, ...active.comparison.milesByProgram }).map(prog => [
                        prog, active.current.milesByProgram[prog] ?? 0, active.comparison.milesByProgram[prog] ?? 0, 'int', false,
                      ] as [string, number, number, 'currency' | 'int', boolean])
                    : active.current.miles > 0
                    ? [['Miles / Pts', active.current.miles, active.comparison.miles, 'int', false] as [string, number, number, 'currency' | 'int', boolean]]
                    : []),
                ] as [string, number, number, 'currency' | 'int', boolean][]).map(([label, cur, prior, fmt2, isNegGood]) => {
                  const diff = cur - prior;
                  const p = pct(cur, prior);
                  const positive = isNegGood ? diff <= 0 : diff >= 0;
                  const display = (n: number) => fmt2 === 'int' ? n.toLocaleString() : fmtExact(n);
                  return (
                    <tr key={label} className="hover:bg-gray-900/40">
                      <td className="px-4 py-2.5 font-medium text-gray-300">{label}</td>
                      <td className="px-4 py-2.5 text-right text-white">{display(cur)}</td>
                      <td className="hidden sm:table-cell px-4 py-2.5 text-right text-gray-400">{display(prior)}</td>
                      <td className="px-4 py-2.5 text-right">
                        {prior === 0 ? (
                          <span className="text-gray-600 text-xs">—</span>
                        ) : (
                          <span className={`text-xs font-medium ${positive ? 'text-green-400' : 'text-red-400'}`}>
                            {diff >= 0 ? '+' : ''}{display(diff)}
                            {p !== null && ` (${p >= 0 ? '+' : ''}${p.toFixed(1)}%)`}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Monthly chart — always visible */}
      {data?.monthly && data.monthly.length > 0 && (
        <div className="rounded-lg border border-gray-800 bg-gray-900/40 p-4">
          <MonthChart months={data.monthly} />
        </div>
      )}
    </div>
  );
}
