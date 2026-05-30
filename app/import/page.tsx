'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { autoParseCSV, type ParsedOrder, type Platform } from '@/lib/csvParsers';
import EmailImport from '@/components/EmailImport';
import * as XLSX from 'xlsx';

type ImportTab = 'csv' | 'email' | 'rules' | 'sender';
type SenderRule = { id: number; label: string; pattern: string };

type Buyer = { id: number; name: string };
type Card = { id: number; name: string; rewardsRate: number };
type ShippingRule = { id: number; label: string; pattern: string; buyerId: number | null; buyer: { id: number; name: string } | null };

type PreviewRow = ParsedOrder & {
  salePrice: string;
  buyerId: string;
  cardId: string;
  cashbackAmount: string;
  skip: boolean;
  blocked: boolean;
  matchedByRule: boolean; // buyer was auto-assigned from a shipping address rule
};

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

export default function ImportPage() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<ImportTab>('csv');
  const [buyers, setBuyers] = useState<Buyer[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [shippingRules, setShippingRules] = useState<ShippingRule[]>([]);
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [platform, setPlatform] = useState<Platform>('unknown');
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<{ count: number; updated: number; skipped: number } | null>(null);

  // Global defaults
  const [defaultBuyerId, setDefaultBuyerId] = useState('');
  const [defaultCardId, setDefaultCardId] = useState('');

  // Shipping rules form
  const [ruleLabel, setRuleLabel] = useState('');
  const [rulePattern, setRulePattern] = useState('');
  const [ruleBuyerId, setRuleBuyerId] = useState('');

  // Sender rules
  const [senderRules, setSenderRules] = useState<SenderRule[]>([]);
  const [senderLabel, setSenderLabel] = useState('');
  const [senderPattern, setSenderPattern] = useState('');

  const [applyingRules, setApplyingRules] = useState(false);
  const [applyResult, setApplyResult] = useState<{ updated: number; scanned: number } | null>(null);

  function loadRules() {
    fetch('/api/shipping-rules').then(r => r.json()).then(setShippingRules);
  }

  function loadSenderRules() {
    fetch('/api/sender-rules').then(r => r.json()).then(setSenderRules);
  }

  useEffect(() => {
    fetch('/api/buyers').then(r => r.json()).then(setBuyers);
    fetch('/api/cards').then(r => r.json()).then(setCards);
    loadRules();
    loadSenderRules();
  }, []);

  function computeCashback(cost: number, shipping: number, cardId: string) {
    const card = cards.find(c => c.id === parseInt(cardId));
    if (!card) return '0';
    return (((cost + shipping) * card.rewardsRate) / 100).toFixed(2);
  }

  const buildRows = useCallback((parsed: ParsedOrder[], cardId: string, buyerId: string, rules: ShippingRule[]) => {
    return parsed.map(o => {
      const isBlocked = false; // blocking handled server-side on import
      // Auto-match buyer from shipping rules when no global default is set
      let autoId = buyerId;
      let matchedByRule = false;
      if (!autoId && o.shippingAddress) {
        const lower = o.shippingAddress.toLowerCase();
        const match = rules.find(r => r.buyerId && lower.includes(r.pattern.toLowerCase()));
        if (match?.buyerId) { autoId = String(match.buyerId); matchedByRule = true; }
      }
      return {
        ...o,
        salePrice: '',
        buyerId: autoId,
        cardId,
        cashbackAmount: computeCashback(o.cost, o.shippingCost, cardId),
        skip: isBlocked,
        blocked: isBlocked,
        matchedByRule,
      };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards]);

  function handleFile(file: File) {
    setError('');
    setImported(null);
    const isExcel = file.name.endsWith('.xlsx') || file.name.endsWith('.xls') || file.type.includes('spreadsheet');
    const reader = new FileReader();
    reader.onerror = () => setError(`Failed to read file: ${reader.error?.message ?? 'unknown error'}`);
    reader.onload = e => {
      try {
        let text: string;
        if (isExcel) {
          const data = new Uint8Array(e.target?.result as ArrayBuffer);
          const wb = XLSX.read(data, { type: 'array' });
          const ws = wb.Sheets[wb.SheetNames[0]];
          text = XLSX.utils.sheet_to_csv(ws);
        } else {
          text = e.target?.result as string;
        }
        const result = autoParseCSV(text);
        if (result.platform === 'unknown' || result.orders.length === 0) {
          setError('Could not detect Amazon or Walmart format. Check the file and try again.');
          setRows([]);
          return;
        }
        setPlatform(result.platform);
        setRows(buildRows(result.orders, defaultCardId, defaultBuyerId, shippingRules));
      } catch (err) {
        setError(`Failed to parse file: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    if (isExcel) {
      reader.readAsArrayBuffer(file);
    } else {
      reader.readAsText(file);
    }
  }

  function updateRow(idx: number, field: keyof PreviewRow, value: string | boolean) {
    setRows(prev => prev.map((r, i) => {
      if (i !== idx) return r;
      const updated = { ...r, [field]: value };
      if (field === 'cardId') {
        updated.cashbackAmount = computeCashback(r.cost, r.shippingCost, value as string);
      }
      if (field === 'buyerId') updated.matchedByRule = false;
      return updated;
    }));
  }

  function applyGlobalDefaults() {
    setRows(prev => prev.map(r => {
      let autoId = defaultBuyerId;
      let matchedByRule = false;
      if (!autoId && r.shippingAddress) {
        const lower = r.shippingAddress.toLowerCase();
        const match = shippingRules.find(rule => rule.buyerId && lower.includes(rule.pattern.toLowerCase()));
        if (match?.buyerId) { autoId = String(match.buyerId); matchedByRule = true; }
      }
      return {
        ...r,
        buyerId: autoId,
        cardId: defaultCardId,
        cashbackAmount: computeCashback(r.cost, r.shippingCost, defaultCardId),
        matchedByRule,
      };
    }));
  }

  async function addRule() {
    if (!rulePattern.trim()) return;
    await fetch('/api/shipping-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: ruleLabel.trim() || rulePattern.trim(),
        pattern: rulePattern.trim(),
        buyerId: ruleBuyerId || null,
      }),
    });
    setRuleLabel('');
    setRulePattern('');
    setRuleBuyerId('');
    loadRules();
  }

  async function removeRule(id: number) {
    await fetch(`/api/shipping-rules/${id}`, { method: 'DELETE' });
    loadRules();
  }

  async function addSenderRule() {
    if (!senderPattern.trim()) return;
    await fetch('/api/sender-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: senderLabel.trim() || senderPattern.trim(),
        pattern: senderPattern.trim(),
      }),
    });
    setSenderLabel('');
    setSenderPattern('');
    loadSenderRules();
  }

  async function removeSenderRule(id: number) {
    await fetch(`/api/sender-rules/${id}`, { method: 'DELETE' });
    loadSenderRules();
  }

  async function handleImport() {
    const toImport = rows.filter(r => !r.skip);
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
        salePrice: r.salePrice ? parseFloat(r.salePrice) : null,
        buyerId: r.buyerId,
        cardId: r.cardId,
        cashbackAmount: parseFloat(r.cashbackAmount) || 0,
        sourceUrl: r.sourceUrl || null,
        shippingAddress: r.shippingAddress || null,
      }))),
    });
    const data = await res.json();
    setImported({ count: data.imported, updated: data.updated ?? 0, skipped: data.skipped ?? 0 });
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
          Import from a CSV file or scan your Gmail inbox for order emails.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-800">
        {([['csv', 'CSV Upload'], ['email', 'Gmail'], ['rules', 'Address Rules'], ['sender', 'Email Routing']] as [ImportTab, string][]).map(([t, label]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm transition-colors -mb-px border-b-2 ${tab === t ? 'border-blue-500 text-white' : 'border-transparent text-gray-400 hover:text-white'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'email' && <EmailImport buyers={buyers} cards={cards} />}

      {tab === 'rules' && (
        <div className="space-y-6">
          <div>
            <h2 className="font-semibold text-base">Shipping Address Rules</h2>
            <p className="text-gray-400 text-sm mt-1">
              When an email or CSV order has a shipping address matching a pattern below,
              the buyer is pre-filled automatically. You can still override it in the import UI.
            </p>
          </div>

          {/* Add rule form */}
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3">
            <p className="text-sm font-medium text-gray-300">Add a rule</p>
            <div className="flex flex-wrap gap-3 items-end">
              <div>
                <label className="label">Label</label>
                <input type="text" value={ruleLabel} onChange={e => setRuleLabel(e.target.value)}
                  className="input w-40 text-sm" placeholder="e.g. BuyingGroup WH" />
              </div>
              <div className="flex-1 min-w-56">
                <label className="label">Address pattern (substring match)</label>
                <input type="text" value={rulePattern} onChange={e => setRulePattern(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addRule()}
                  className="input w-full text-sm" placeholder="e.g. 1234 Warehouse Blvd or 60601" />
              </div>
              <div>
                <label className="label">Assign to buyer</label>
                <select value={ruleBuyerId} onChange={e => setRuleBuyerId(e.target.value)} className="input w-44 text-sm">
                  <option value="">— none —</option>
                  {buyers.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
              <button onClick={addRule} disabled={!rulePattern.trim()}
                className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm px-4 py-2 rounded-md transition-colors">
                Add Rule
              </button>
            </div>
          </div>

          {/* Rules list */}
          {shippingRules.length === 0 ? (
            <p className="text-gray-600 text-sm">No rules yet. Add one above to start auto-assigning buyers.</p>
          ) : (
            <div className="rounded-lg border border-gray-800 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-900 text-gray-400 text-xs uppercase">
                  <tr>
                    <th className="px-4 py-2 text-left">Label</th>
                    <th className="px-4 py-2 text-left">Pattern</th>
                    <th className="px-4 py-2 text-left">Assigns to</th>
                    <th className="px-4 py-2 w-10"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {shippingRules.map(r => (
                    <tr key={r.id} className="hover:bg-gray-900/40">
                      <td className="px-4 py-2 text-gray-200">{r.label}</td>
                      <td className="px-4 py-2 font-mono text-xs text-gray-400">{r.pattern}</td>
                      <td className="px-4 py-2 text-gray-300">
                        {r.buyer?.name ?? <span className="text-gray-600">— none —</span>}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <button onClick={() => removeRule(r.id)}
                          className="text-gray-600 hover:text-red-400 transition-colors text-xs">
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex items-center gap-4 pt-2">
            <button
              onClick={async () => {
                setApplyingRules(true);
                setApplyResult(null);
                const res = await fetch('/api/orders/apply-rules', { method: 'POST' });
                const data = await res.json();
                setApplyResult(data);
                setApplyingRules(false);
              }}
              disabled={applyingRules || shippingRules.filter(r => r.buyer).length === 0}
              className="bg-gray-800 hover:bg-gray-700 border border-gray-700 disabled:opacity-40 text-gray-300 text-sm px-4 py-2 rounded-md transition-colors"
            >
              {applyingRules ? 'Applying…' : 'Apply rules to existing orders'}
            </button>
            {applyResult && (
              <p className="text-sm text-gray-400">
                {applyResult.updated > 0
                  ? <span className="text-green-400">Updated {applyResult.updated} order{applyResult.updated !== 1 ? 's' : ''}</span>
                  : 'No matches found'
                }
                {' '}({applyResult.scanned} unassigned orders scanned)
              </p>
            )}
          </div>
        </div>
      )}

      {tab === 'sender' && (
        <div className="space-y-6">
          <div>
            <h2 className="font-semibold text-base">Email Routing Rules</h2>
            <p className="text-gray-400 text-sm mt-1">
              When syncing Gmail, emails matching a sender pattern are assigned to your account.
              Use this to separate order emails between users — e.g. if Amazon sends to different addresses.
            </p>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3">
            <p className="text-sm font-medium text-gray-300">Add a rule</p>
            <div className="flex flex-wrap gap-3 items-end">
              <div>
                <label className="label">Label</label>
                <input type="text" value={senderLabel} onChange={e => setSenderLabel(e.target.value)}
                  className="input w-40 text-sm" placeholder="e.g. My Amazon" />
              </div>
              <div className="flex-1 min-w-56">
                <label className="label">Sender pattern (substring match)</label>
                <input type="text" value={senderPattern} onChange={e => setSenderPattern(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addSenderRule()}
                  className="input w-full text-sm" placeholder="e.g. amazon.com or buyer@walmart.com" />
              </div>
              <button onClick={addSenderRule} disabled={!senderPattern.trim()}
                className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm px-4 py-2 rounded-md transition-colors">
                Add Rule
              </button>
            </div>
          </div>

          {senderRules.length === 0 ? (
            <p className="text-gray-600 text-sm">No rules yet. If only one person uses Gmail import, you don&apos;t need any.</p>
          ) : (
            <div className="rounded-lg border border-gray-800 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-900 text-gray-400 text-xs uppercase">
                  <tr>
                    <th className="px-4 py-2 text-left">Label</th>
                    <th className="px-4 py-2 text-left">Sender pattern</th>
                    <th className="px-4 py-2 w-10"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {senderRules.map(r => (
                    <tr key={r.id} className="hover:bg-gray-900/40">
                      <td className="px-4 py-2 text-gray-200">{r.label}</td>
                      <td className="px-4 py-2 font-mono text-xs text-gray-400">{r.pattern}</td>
                      <td className="px-4 py-2 text-right">
                        <button onClick={() => removeSenderRule(r.id)}
                          className="text-gray-600 hover:text-red-400 transition-colors text-xs">
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'csv' && <>
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
          onDrop={e => { e.preventDefault(); e.stopPropagation(); const file = e.dataTransfer.files[0]; if (file) handleFile(file); }}
          onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
          onDragEnter={e => { e.preventDefault(); e.stopPropagation(); }}
          onClick={() => fileRef.current?.click()}
          className="border-2 border-dashed border-gray-700 hover:border-blue-500 rounded-lg p-12 text-center cursor-pointer transition-colors"
        >
          <p className="text-gray-400">Drop your CSV or Excel file here or click to browse</p>
          <p className="text-gray-600 text-xs mt-1">Amazon or Walmart format auto-detected · CSV, TSV, or XLSX</p>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.tsv,.txt,.xlsx,.xls"
            className="hidden"
            onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])}
          />
        </div>
      )}

      {error && <p className="text-red-400 text-sm">{error}</p>}

      {imported !== null && (
        <div className="bg-green-900/30 border border-green-700 rounded-lg p-4 flex items-center justify-between">
          <p className="text-green-400">
            {imported?.count > 0 && <>Imported {imported.count} new order{imported.count !== 1 ? 's' : ''}.</>}
            {imported?.updated > 0 && <span className="ml-1">Updated {imported.updated} existing order{imported.updated !== 1 ? 's' : ''} with missing info.</span>}
            {imported?.count === 0 && imported?.updated === 0 && 'No new orders — '}
            {imported && imported.skipped > 0 && (
              <span className="text-yellow-400 ml-1">· {imported.skipped} skipped (duplicates within batch).</span>
            )}
          </p>
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
                  <th className="px-3 py-2 text-right">Cashback ($)</th>
                  <th className="px-3 py-2 text-right w-28">Sale Price ($)</th>
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
                    <td className="px-3 py-2 text-xs">
                      {r.sourceUrl
                        ? <a href={r.sourceUrl} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline font-mono">{r.orderNumber}</a>
                        : <span className="text-gray-500 font-mono">{r.orderNumber}</span>}
                    </td>
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
                        className="input w-20 text-right text-xs py-1 text-green-400 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                      />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <input
                        type="number" step="0.01" min="0"
                        value={r.salePrice}
                        onChange={e => updateRow(i, 'salePrice', e.target.value)}
                        disabled={r.skip}
                        placeholder="optional"
                        className="input w-24 text-right text-xs py-1 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
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
                      {r.matchedByRule && (
                        <div className="text-purple-500 text-xs mt-0.5">matched address rule</div>
                      )}
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
      </>}
    </div>
  );
}
