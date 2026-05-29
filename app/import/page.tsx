'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { autoParseCSV, isAddressBlocked, type ParsedOrder, type Platform } from '@/lib/csvParsers';

type Buyer = { id: number; name: string };
type Card = { id: number; name: string; rewardsRate: number };
type BlockedAddress = { id: number; label: string; pattern: string };

type PreviewRow = ParsedOrder & {
  salePrice: string;
  buyerId: string;
  cardId: string;
  cashbackAmount: string;
  skip: boolean;
  blocked: boolean; // matched a blocked address pattern
};

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

export default function ImportPage() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [buyers, setBuyers] = useState<Buyer[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [blocked, setBlocked] = useState<BlockedAddress[]>([]);
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [platform, setPlatform] = useState<Platform>('unknown');
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<number | null>(null);

  // Global defaults
  const [defaultBuyerId, setDefaultBuyerId] = useState('');
  const [defaultCardId, setDefaultCardId] = useState('');

  // Blocklist form
  const [newLabel, setNewLabel] = useState('');
  const [newPattern, setNewPattern] = useState('');

  function loadBlocked() {
    fetch('/api/blocked-addresses').then(r => r.json()).then(setBlocked);
  }

  useEffect(() => {
    fetch('/api/buyers').then(r => r.json()).then(setBuyers);
    fetch('/api/cards').then(r => r.json()).then(setCards);
    loadBlocked();
  }, []);

  function computeCashback(cost: number, shipping: number, cardId: string) {
    const card = cards.find(c => c.id === parseInt(cardId));
    if (!card) return '0';
    return (((cost + shipping) * card.rewardsRate) / 100).toFixed(2);
  }

  const buildRows = useCallback((parsed: ParsedOrder[], cardId: string, buyerId: string, blockedList: BlockedAddress[]) => {
    const patterns = blockedList.map(b => b.pattern);
    return parsed.map(o => {
      const isBlocked = isAddressBlocked(o.shippingAddress, patterns);
      return {
        ...o,
        salePrice: '',
        buyerId,
        cardId,
        cashbackAmount: computeCashback(o.cost, o.shippingCost, cardId),
        skip: isBlocked,
        blocked: isBlocked,
      };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards]);

  function handleFile(file: File) {
    setError('');
    setImported(null);
    const reader = new FileReader();
    reader.onload = e => {
      const text = e.target?.result as string;
      const result = autoParseCSV(text);
      if (result.platform === 'unknown' || result.orders.length === 0) {
        setError('Could not detect Amazon or Walmart format. Check the file and try again.');
        setRows([]);
        return;
      }
      setPlatform(result.platform);
      setRows(buildRows(result.orders, defaultCardId, defaultBuyerId, blocked));
    };
    reader.readAsText(file);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }

  function updateRow(idx: number, field: keyof PreviewRow, value: string | boolean) {
    setRows(prev => prev.map((r, i) => {
      if (i !== idx) return r;
      const updated = { ...r, [field]: value };
      if (field === 'cardId') {
        updated.cashbackAmount = computeCashback(r.cost, r.shippingCost, value as string);
      }
      return updated;
    }));
  }

  function applyGlobalDefaults() {
    setRows(prev => prev.map(r => ({
      ...r,
      buyerId: defaultBuyerId,
      cardId: defaultCardId,
      cashbackAmount: computeCashback(r.cost, r.shippingCost, defaultCardId),
    })));
  }

  async function addBlocked() {
    if (!newPattern.trim()) return;
    await fetch('/api/blocked-addresses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: newLabel.trim() || newPattern.trim(), pattern: newPattern.trim() }),
    });
    setNewLabel('');
    setNewPattern('');
    loadBlocked();
  }

  async function removeBlocked(id: number) {
    await fetch(`/api/blocked-addresses/${id}`, { method: 'DELETE' });
    loadBlocked();
  }

  async function handleImport() {
    const toImport = rows.filter(r => !r.skip);
    if (toImport.some(r => !r.salePrice)) {
      setError("Enter a sale price for all active rows, or skip rows you don't want to import yet.");
      return;
    }
    setImporting(true);
    setError('');
    const res = await fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toImport.map(r => ({
        platform: r.platform,
        orderNumber: r.orderNumber,
        orderDate: r.orderDate,
        itemDescription: r.itemDescription,
        cost: r.cost,
        shippingCost: r.shippingCost,
        salePrice: parseFloat(r.salePrice) || 0,
        buyerId: r.buyerId,
        cardId: r.cardId,
        cashbackAmount: parseFloat(r.cashbackAmount) || 0,
      }))),
    });
    const data = await res.json();
    setImported(data.imported);
    setRows([]);
    setImporting(false);
  }

  const activeRows = rows.filter(r => !r.skip);
  const blockedRows = rows.filter(r => r.blocked);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Import Orders</h1>
        <p className="text-gray-400 text-sm mt-1">
          Upload a CSV from Amazon or Walmart — orders shipped to blocked addresses are auto-skipped.
        </p>
      </div>

      {/* Blocked addresses */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3">
        <h2 className="font-medium text-sm">Blocked Shipping Addresses</h2>
        <p className="text-gray-500 text-xs">Orders where the shipping address contains any pattern below will be skipped automatically on import.</p>

        <div className="flex gap-2 flex-wrap">
          <input
            type="text"
            value={newLabel}
            onChange={e => setNewLabel(e.target.value)}
            className="input w-36 text-sm"
            placeholder="Label (e.g. Home)"
          />
          <input
            type="text"
            value={newPattern}
            onChange={e => setNewPattern(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addBlocked()}
            className="input flex-1 min-w-48 text-sm"
            placeholder="Address pattern (e.g. 123 Main St or 90210)"
          />
          <button
            onClick={addBlocked}
            disabled={!newPattern.trim()}
            className="bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white text-sm px-3 py-2 rounded-md transition-colors"
          >
            Add
          </button>
        </div>

        {blocked.length === 0 ? (
          <p className="text-gray-600 text-xs">No blocked addresses yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {blocked.map(b => (
              <div key={b.id} className="flex items-center gap-2 bg-gray-800 border border-gray-700 rounded-md px-3 py-1.5 text-sm">
                <span className="text-gray-300">{b.label}</span>
                <span className="text-gray-500 text-xs font-mono">"{b.pattern}"</span>
                <button onClick={() => removeBlocked(b.id)} className="text-gray-600 hover:text-red-400 transition-colors ml-1">✕</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* How to get CSVs */}
      <div className="grid md:grid-cols-2 gap-4 text-sm">
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-1">
          <p className="font-medium text-white">Amazon CSV</p>
          <p className="text-gray-400"><span className="text-gray-300">Firefox:</span> Install <a href="https://addons.mozilla.org/en-US/firefox/addon/order-history-exporter-amazon/" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">Order History Exporter for Amazon</a> → go to your Orders page → export as CSV.</p>
          <p className="text-gray-400 mt-1"><span className="text-gray-300">Chrome:</span> Use the Amazon Order History Reporter extension, or Account → Data &amp; Privacy → Request your data → Order History (takes 1–3 days).</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-1">
          <p className="font-medium text-white">Walmart CSV</p>
          <p className="text-gray-400">No Firefox extension exists. Use the <span className="text-gray-300">Walmart Invoice Exporter</span> Chrome extension, or open Chrome just for this step.</p>
        </div>
      </div>

      {/* Drop zone */}
      {rows.length === 0 && (
        <div
          onDrop={onDrop}
          onDragOver={e => e.preventDefault()}
          onClick={() => fileRef.current?.click()}
          className="border-2 border-dashed border-gray-700 hover:border-blue-500 rounded-lg p-12 text-center cursor-pointer transition-colors"
        >
          <p className="text-gray-400">Drop your CSV here or click to browse</p>
          <p className="text-gray-600 text-xs mt-1">Amazon or Walmart format auto-detected</p>
          <input
            ref={fileRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])}
          />
        </div>
      )}

      {error && <p className="text-red-400 text-sm">{error}</p>}

      {imported !== null && (
        <div className="bg-green-900/30 border border-green-700 rounded-lg p-4 flex items-center justify-between">
          <p className="text-green-400">Successfully imported {imported} order{imported !== 1 ? 's' : ''}.</p>
          <button onClick={() => router.push('/orders')} className="text-sm text-green-300 hover:text-white underline">
            View Orders →
          </button>
        </div>
      )}

      {rows.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-400">
              <span className="text-white font-medium">{platform === 'amazon' ? 'Amazon' : 'Walmart'}</span>
              {' '}· {activeRows.length} of {rows.length} rows selected
              {blockedRows.length > 0 && (
                <span className="text-yellow-500 ml-2">· {blockedRows.length} auto-skipped (blocked address)</span>
              )}
            </p>
            <button onClick={() => { setRows([]); setError(''); }} className="text-xs text-gray-500 hover:text-white transition-colors">
              ✕ Clear and re-upload
            </button>
          </div>

          {/* Global defaults */}
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 flex flex-wrap gap-4 items-end">
            <p className="text-sm font-medium text-gray-300 w-full">Apply to all rows:</p>
            <div>
              <label className="label">Buyer</label>
              <select value={defaultBuyerId} onChange={e => setDefaultBuyerId(e.target.value)} className="input w-44">
                <option value="">— none —</option>
                {buyers.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Card</label>
              <select value={defaultCardId} onChange={e => setDefaultCardId(e.target.value)} className="input w-48">
                <option value="">— none —</option>
                {cards.map(c => <option key={c.id} value={c.id}>{c.name} ({c.rewardsRate}%)</option>)}
              </select>
            </div>
            <button onClick={applyGlobalDefaults} className="bg-gray-700 hover:bg-gray-600 text-white text-sm px-3 py-2 rounded-md transition-colors">
              Apply
            </button>
          </div>

          {/* Preview table */}
          <div className="rounded-lg border border-gray-800 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-900 text-gray-400 text-xs uppercase">
                <tr>
                  <th className="px-3 py-2 text-left w-8"></th>
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">Order #</th>
                  <th className="px-3 py-2 text-left">Item</th>
                  <th className="px-3 py-2 text-right">Cost</th>
                  <th className="px-3 py-2 text-right">Ship</th>
                  <th className="px-3 py-2 text-right">Cashback</th>
                  <th className="px-3 py-2 text-right w-28">Sale Price *</th>
                  <th className="px-3 py-2 text-left">Buyer</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {rows.map((r, i) => (
                  <tr key={i} className={r.skip ? 'opacity-40' : 'hover:bg-gray-900/40'}>
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={!r.skip}
                        onChange={e => updateRow(i, 'skip', !e.target.checked)}
                        className="accent-blue-500"
                      />
                    </td>
                    <td className="px-3 py-2 text-gray-400 whitespace-nowrap">{r.orderDate}</td>
                    <td className="px-3 py-2 text-gray-500 text-xs">{r.orderNumber}</td>
                    <td className="px-3 py-2 max-w-[160px]">
                      <div className="truncate" title={r.itemDescription}>{r.itemDescription || '—'}</div>
                      {r.blocked && (
                        <span className="text-yellow-600 text-xs">blocked address</span>
                      )}
                      {r.shippingAddress && !r.blocked && (
                        <div className="text-gray-600 text-xs truncate" title={r.shippingAddress}>{r.shippingAddress}</div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-gray-400">{fmt(r.cost)}</td>
                    <td className="px-3 py-2 text-right text-gray-500">{r.shippingCost > 0 ? fmt(r.shippingCost) : '—'}</td>
                    <td className="px-3 py-2 text-right">
                      <input
                        type="number" step="0.01" min="0"
                        value={r.cashbackAmount}
                        onChange={e => updateRow(i, 'cashbackAmount', e.target.value)}
                        disabled={r.skip}
                        className="input w-20 text-right text-xs py-1 text-green-400"
                      />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <input
                        type="number" step="0.01" min="0"
                        value={r.salePrice}
                        onChange={e => updateRow(i, 'salePrice', e.target.value)}
                        disabled={r.skip}
                        placeholder="0.00"
                        className="input w-24 text-right text-xs py-1"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <select
                        value={r.buyerId}
                        onChange={e => updateRow(i, 'buyerId', e.target.value)}
                        disabled={r.skip}
                        className="input text-xs py-1 w-32"
                      >
                        <option value="">— none —</option>
                        {buyers.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
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
              disabled={importing || activeRows.length === 0}
              className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-5 py-2 rounded-md text-sm transition-colors"
            >
              {importing ? 'Importing…' : `Import ${activeRows.length} Order${activeRows.length !== 1 ? 's' : ''}`}
            </button>
            {error && <p className="text-red-400 text-sm">{error}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
