'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export const money = (c: number | null | undefined) =>
  c == null ? '-' : (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export async function api<T = unknown>(url: string, method = 'GET', body?: unknown): Promise<{ ok: boolean; data: T & { error?: string } }> {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  let data: unknown = {};
  try { data = await r.json(); } catch { /* empty */ }
  return { ok: r.ok, data: data as T & { error?: string } };
}

const TABS = [
  { href: '/books', label: 'Overview' },
  { href: '/books/costs', label: 'Costs' },
  { href: '/books/opening', label: 'Opening balances' },
  { href: '/books/parity', label: 'Parity' },
  { href: '/books/locks', label: 'Period locks' },
];

export function BooksShell({ title, children }: { title: string; children: React.ReactNode }) {
  const path = usePathname();
  return (
    <div className="max-w-6xl mx-auto px-4 py-6 space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-white">{title}</h1>
        <p className="text-xs text-gray-500 mt-1">Bookkeeping estimate for your records. Figures are estimates, not tax advice.</p>
      </div>
      <div className="flex flex-wrap gap-2 text-sm">
        {TABS.map(t => (
          <Link key={t.href} href={t.href} className={`px-3 py-1 rounded-md border ${path === t.href ? 'border-blue-500 text-white bg-blue-950/40' : 'border-gray-700 text-gray-400 hover:text-white'}`}>{t.label}</Link>
        ))}
      </div>
      {children}
    </div>
  );
}

export function Off() {
  return <div className="text-sm text-gray-400 border border-gray-800 rounded-md p-4">Books are off. Turn them on from the <a className="underline" href="/books">Books overview</a> (or Settings key <code>accounting.enabled</code>).</div>;
}

export function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="overflow-x-auto border border-gray-800 rounded-md">
      <table className="w-full text-sm">
        <thead className="text-gray-400 text-xs"><tr>{head.map(h => <th key={h} className="text-left font-medium px-3 py-2">{h}</th>)}</tr></thead>
        <tbody>{rows.length === 0 ? <tr><td className="px-3 py-3 text-gray-500" colSpan={head.length}>Nothing yet.</td></tr> : rows.map((r, i) => (
          <tr key={i} className="border-t border-gray-800">{r.map((c, j) => <td key={j} className="px-3 py-1.5 text-gray-200">{c}</td>)}</tr>
        ))}</tbody>
      </table>
    </div>
  );
}
