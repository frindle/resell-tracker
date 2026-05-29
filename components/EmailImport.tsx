'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { ParsedEmailOrder } from '@/lib/emailSync';

type Buyer = { id: number; name: string };
type Card = { id: number; name: string; rewardsRate: number };

type EmailRow = ParsedEmailOrder & {
  salePrice: string;
  buyerId: string;
  cardId: string;
  cashbackAmount: string;
  selected: boolean;
};

const PLATFORM_BADGE: Record<string, string> = {
  Amazon: 'bg-yellow-900/50 text-yellow-300',
  Walmart: 'bg-blue-900/50 text-blue-300',
  BuyingGroup: 'bg-purple-900/50 text-purple-300',
  Unknown: 'bg-gray-800 text-gray-400',
};

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

export default function EmailImport({ buyers, cards }: { buyers: Buyer[]; cards: Card[] }) {
  const [rows, setRows] = useState<EmailRow[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const [imported, setImported] = useState<number | null>(null);

  function cashback(cost: number, cardId: string) {
    const card = cards.find(c => c.id === parseInt(cardId));
    if (!card) return '0';
    return ((cost * card.rewardsRate) / 100).toFixed(2);
  }

  async function sync() {
    setSyncing(true);
    setError('');
    setImported(null);
    try {
      const res = await fetch('/api/email/sync');
      if (res.status === 400) {
        setError('Gmail not configured. Add your credentials in Settings.');
        return;
      }
      if (!res.ok) {
        setError(`Gmail sync failed: ${await res.text()}`);
        return;
      }
      const emails: ParsedEmailOrder[] = await res.json();
      if (emails.length === 0) {
        setError('No order emails found in your inbox.');
        return;
      }
      setRows(emails.map(e => ({
        ...e,
        salePrice: '',
        buyerId: '',
        cardId: '',
        cashbackAmount: '0',
        selected: true,
      })));
    } finally {
      setSyncing(false);
    }
  }

  function updateRow(idx: number, field: keyof EmailRow, value: string | boolean | number) {
    setRows(prev => prev.map((r, i) => {
      if (i !== idx) return r;
      const updated = { ...r, [field]: value };
      if (field === 'cardId') updated.cashbackAmount = cashback(r.cost, value as string);
      if (field === 'cost') updated.cashbackAmount = cashback(value as number, r.cardId);
      return updated;
    }));
  }

  async function handleImport() {
    const toImport = rows.filter(r => r.selected);
    if (!toImport.length) return;
    if (toImport.some(r => !r.salePrice || parseFloat(r.salePrice) <= 0)) {
      setError('Enter a sale price for every selected row.');
      return;
    }

    setImporting(true);
    setError('');

    // Create orders
    const res = await fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toImport.map(r => ({
        platform: r.platform === 'Unknown' ? 'Other' : r.platform,
        orderNumber: r.orderNumber,
        orderDate: r.date,
        itemDescription: r.itemDescription,
        cost: r.cost,
        shippingCost: 0,
        salePrice: parseFloat(r.salePrice) || 0,
        buyerId: r.buyerId,
        cardId: r.cardId,
        cashbackAmount: parseFloat(r.cashbackAmount) || 0,
      }))),
    });
    const data = await res.json();

    // Delete processed emails from Gmail
    const uidsToDelete = toImport.map(r => r.uid);
    await fetch('/api/email/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uids: uidsToDelete }),
    });

    setImported(data.imported);
    setRows(prev => prev.filter(r => !r.selected));
    setImporting(false);
  }

  const selected = rows.filter(r => r.selected);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button
          onClick={sync}
          disabled={syncing}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm px-4 py-2 rounded-md transition-colors"
        >
          {syncing ? 'Connecting to Gmail…' : 'Sync Gmail'}
        </button>
        <p className="text-gray-500 text-xs">
          Searches your inbox for order emails from Amazon, Walmart, and BuyingGroup.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-900/20 px-4 py-3 text-sm text-red-300">
          {error}{' '}
          {error.includes('Settings') && (
            <Link href="/settings" className="underline hover:text-red-200">Go to Settings</Link>
          )}
        </div>
      )}

      {imported !== null && (
        <div className="bg-green-900/30 border border-green-700 rounded-lg px-4 py-3 text-green-400 text-sm">
          Imported {imported} order{imported !== 1 ? 's' : ''} and deleted from Gmail.
        </div>
      )}

      {rows.length > 0 && (
        <>
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-400">
              {rows.length} email{rows.length !== 1 ? 's' : ''} found
              · {selected.length} selected
            </p>
            <button onClick={() => setRows([])} className="text-xs text-gray-500 hover:text-white transition-colors">
              ✕ Clear
            </button>
          </div>

          <div className="rounded-lg border border-gray-800 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-900 text-gray-400 text-xs uppercase">
                <tr>
                  <th className="px-3 py-2 w-8"></th>
                  <th className="px-3 py-2 text-left">Platform</th>
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">Order #</th>
                  <th className="px-3 py-2 text-left">Subject</th>
                  <th className="px-3 py-2 text-right w-24">Cost</th>
                  <th className="px-3 py-2 text-right w-24">Cashback</th>
                  <th className="px-3 py-2 text-right w-28">Sale Price *</th>
                  <th className="px-3 py-2 text-left">Buyer</th>
                  <th className="px-3 py-2 text-left">Card</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {rows.map((r, i) => (
                  <tr key={r.uid} className={r.selected ? 'hover:bg-gray-900/40' : 'opacity-40'}>
                    <td className="px-3 py-2">
                      <input type="checkbox" checked={r.selected}
                        onChange={e => updateRow(i, 'selected', e.target.checked)}
                        className="accent-blue-500" />
                    </td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${PLATFORM_BADGE[r.platform]}`}>
                        {r.platform}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-gray-400 whitespace-nowrap text-xs">
                      {new Date(r.date).toLocaleDateString()}
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="text"
                        value={r.orderNumber}
                        onChange={e => updateRow(i, 'orderNumber', e.target.value)}
                        disabled={!r.selected}
                        className="input text-xs py-1 w-36 font-mono"
                        placeholder="Order #"
                      />
                    </td>
                    <td className="px-3 py-2 max-w-[200px]">
                      <div className="truncate text-gray-300 text-xs" title={r.subject}>{r.subject}</div>
                      {r.rawSnippet && (
                        <div className="truncate text-gray-600 text-xs mt-0.5" title={r.rawSnippet}>{r.rawSnippet.slice(0, 80)}</div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <input
                        type="number" step="0.01" min="0"
                        value={r.cost || ''}
                        onChange={e => updateRow(i, 'cost', parseFloat(e.target.value) || 0)}
                        disabled={!r.selected}
                        className="input w-20 text-right text-xs py-1"
                        placeholder="0.00"
                      />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <input
                        type="number" step="0.01" min="0"
                        value={r.cashbackAmount}
                        onChange={e => updateRow(i, 'cashbackAmount', e.target.value)}
                        disabled={!r.selected}
                        className="input w-20 text-right text-xs py-1 text-green-400"
                      />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <input
                        type="number" step="0.01" min="0"
                        value={r.salePrice}
                        onChange={e => updateRow(i, 'salePrice', e.target.value)}
                        disabled={!r.selected}
                        placeholder="0.00"
                        className="input w-24 text-right text-xs py-1"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <select value={r.buyerId} disabled={!r.selected}
                        onChange={e => updateRow(i, 'buyerId', e.target.value)}
                        className="input text-xs py-1 w-32">
                        <option value="">— none —</option>
                        {buyers.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      <select value={r.cardId} disabled={!r.selected}
                        onChange={e => updateRow(i, 'cardId', e.target.value)}
                        className="input text-xs py-1 w-36">
                        <option value="">— none —</option>
                        {cards.map(c => <option key={c.id} value={c.id}>{c.name} ({c.rewardsRate}%)</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center gap-4">
            <button
              onClick={handleImport}
              disabled={importing || selected.length === 0}
              className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-5 py-2 rounded-md text-sm transition-colors"
            >
              {importing ? 'Importing…' : `Import ${selected.length} Order${selected.length !== 1 ? 's' : ''} + Delete Emails`}
            </button>
            <p className="text-xs text-gray-500">Emails are permanently moved to Gmail Trash after import.</p>
          </div>
        </>
      )}

      {!syncing && rows.length === 0 && !error && (
        <div className="rounded-lg border border-dashed border-gray-700 py-10 text-center text-gray-500 text-sm">
          <p>Click "Sync Gmail" to scan your inbox for order emails.</p>
          <p className="text-xs mt-1 text-gray-600">Looks for emails from Amazon, Walmart, and BuyingGroup in the last 100 messages.</p>
        </div>
      )}
    </div>
  );
}
