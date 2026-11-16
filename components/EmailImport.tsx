'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { ParsedEmailOrder } from '@/lib/emailSync';
import { mergeEmailImportRows, type EmailKind, type EmailRowInput } from '@/lib/emailParse';
import type { ResolvedMerchant } from '@/lib/merchants';

type Buyer = { id: number; name: string };
type Card = { id: number; name: string; rewardsRate: number };

type Routing = 'mine' | 'unassigned' | 'ambiguous';
type SyncedEmail = ParsedEmailOrder & { matchedBuyerId?: number | null; routing?: Routing; merchant?: ResolvedMerchant };

type EmailRow = SyncedEmail & {
  store: string; // store name for a sender the parser has no built-in handling for
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
  Costco: 'bg-red-900/50 text-red-300',
  Lenovo: 'bg-pink-900/50 text-pink-300',
  Unknown: 'bg-gray-800 text-gray-400',
};

const KIND_BADGE: Record<EmailKind, string> = {
  ordered: 'bg-emerald-900/40 text-emerald-300',
  shipped: 'bg-sky-900/40 text-sky-300',
  delivered: 'bg-teal-900/40 text-teal-300',
  cancelled: 'bg-red-900/40 text-red-300',
  refund: 'bg-orange-900/40 text-orange-300',
  other: 'bg-gray-800 text-gray-400',
};

// Ordered/shipped/delivered emails with an order number are picked by
// default. Cancellations, refunds, emails no user claims, and anything
// without an order number wait for a human.
function selectedByDefault(e: SyncedEmail): boolean {
  if (e.routing && e.routing !== 'mine') return false;
  if (!['ordered', 'shipped', 'delivered'].includes(e.kind)) return false;
  return /\d/.test(e.orderNumber);
}

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

// ---------------------------------------------------------------------------
// Address popover — click an address to assign a buyer and save a rule
// ---------------------------------------------------------------------------

function AddressPopover({
  address,
  buyers,
  onAssign,
  onClose,
}: {
  address: string;
  buyers: Buyer[];
  onAssign: (buyerId: string, buyerName: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [newName, setNewName] = useState('');
  const [saving, setSaving] = useState(false);

  // Close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  async function saveRule(buyerId: number, buyerName: string) {
    // Use last meaningful part of the address as the pattern (zip or city)
    const zip = address.match(/\b\d{5}\b/)?.[0];
    const pattern = zip ?? address.slice(0, 40);
    await fetch('/api/shipping-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: buyerName, pattern, buyerId }),
    });
  }

  async function assignExisting(buyer: Buyer) {
    setSaving(true);
    try {
      await saveRule(buyer.id, buyer.name);
      onAssign(String(buyer.id), buyer.name);
    } finally {
      setSaving(false);
    }
  }

  async function createAndAssign() {
    const name = newName.trim();
    if (!name) return;
    setSaving(true);
    try {
      const res = await fetch('/api/buyers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const buyer: Buyer = await res.json();
      await saveRule(buyer.id, buyer.name);
      onAssign(String(buyer.id), buyer.name);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      ref={ref}
      className="absolute z-50 left-0 top-full mt-1 w-64 bg-gray-900 border border-gray-700 rounded-lg shadow-xl text-sm"
    >
      <div className="px-3 py-2 border-b border-gray-800">
        <p className="text-gray-500 text-xs font-medium uppercase tracking-wide">Assign address to group</p>
        <p className="text-gray-400 text-xs mt-0.5 truncate" title={address}>{address}</p>
      </div>

      {/* Existing buyers */}
      <div className="max-h-40 overflow-y-auto">
        {buyers.map(b => (
          <button
            key={b.id}
            onClick={() => assignExisting(b)}
            disabled={saving}
            className="w-full text-left px-3 py-2 text-gray-300 hover:bg-gray-800 hover:text-white transition-colors disabled:opacity-40"
          >
            {b.name}
          </button>
        ))}
      </div>

      {/* New group */}
      <div className="border-t border-gray-800 px-3 py-2 space-y-2">
        <p className="text-gray-500 text-xs">New group</p>
        <div className="flex gap-2">
          <input
            type="text"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && createAndAssign()}
            placeholder="Group name…"
            className="input text-xs py-1 flex-1"
            autoFocus
          />
          <button
            onClick={createAndAssign}
            disabled={saving || !newName.trim()}
            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-xs px-2 py-1 rounded-md transition-colors"
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function EmailImport({
  buyers: initialBuyers,
  cards,
}: {
  buyers: Buyer[];
  cards: Card[];
}) {
  const [buyers, setBuyers] = useState<Buyer[]>(initialBuyers);
  const [rows, setRows] = useState<EmailRow[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const [imported, setImported] = useState<{ count: number; updated: number; skipped: number; noMatch: number; dropped: number; cancelled: number } | null>(null);
  const [openPopover, setOpenPopover] = useState<number | null>(null);
  const [syncWindow, setSyncWindow] = useState<'3m' | '6m' | '1y' | 'all'>('3m');

  function cashback(cost: number, cardId: string) {
    const card = cards.find(c => c.id === parseInt(cardId));
    if (!card) return '0';
    return ((cost * card.rewardsRate) / 100).toFixed(2);
  }

  function sinceDate(window: typeof syncWindow): string | null {
    if (window === 'all') return null;
    const d = new Date();
    if (window === '3m') d.setMonth(d.getMonth() - 3);
    if (window === '6m') d.setMonth(d.getMonth() - 6);
    if (window === '1y') d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().split('T')[0];
  }

  async function sync() {
    setSyncing(true);
    setError('');
    setImported(null);
    try {
      const since = sinceDate(syncWindow);
      const url = since ? `/api/email/sync?since=${since}` : '/api/email/sync';
      const res = await fetch(url);
      if (res.status === 400) {
        setError('Order email inbox not set up. Add it in Settings.');
        return;
      }
      if (!res.ok) {
        setError(`Inbox sync failed: ${await res.text()}`);
        return;
      }
      const emails: SyncedEmail[] = await res.json();
      if (emails.length === 0) {
        setError('No order emails found in the selected time range.');
        return;
      }
      setRows(emails.map(e => ({
        ...e,
        store: e.platform === 'Unknown' ? (e.merchant?.platform ?? '') : '',
        salePrice: '',
        buyerId: e.matchedBuyerId ? String(e.matchedBuyerId) : '',
        cardId: '',
        cashbackAmount: '0',
        selected: selectedByDefault(e),
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

  // Called when the popover assigns a buyer — update the row and close
  function handleAssign(rowIdx: number, buyerId: string, buyerName: string) {
    // If a new buyer was created, add to local list
    if (!buyers.find(b => String(b.id) === buyerId)) {
      setBuyers(prev => [...prev, { id: parseInt(buyerId), name: buyerName }]);
    }
    updateRow(rowIdx, 'buyerId', buyerId);
    setOpenPopover(null);
  }

  async function handleImport() {
    const toImport = rows.filter(r => r.selected);
    if (!toImport.length) return;
    setImporting(true);
    setError('');

    try {
      // One order per order number: the "Ordered" email gives cost and
      // address, shipping emails add tracking, a cancellation marks it.
      const inputs: EmailRowInput[] = toImport.map(r => ({
        kind: r.kind,
        platform: r.platform === 'Unknown' ? (r.store.trim() || 'Other') : r.platform,
        orderNumber: r.orderNumber.trim(),
        orderDate: r.date,
        itemDescription: r.itemDescription,
        cost: r.cost,
        shippingCost: 0,
        salePrice: r.salePrice ? parseFloat(r.salePrice) : null,
        buyerId: r.buyerId,
        cardId: r.cardId,
        cashbackAmount: parseFloat(r.cashbackAmount) || 0,
        shippingAddress: r.shippingAddress || '',
        trackingNumbers: r.trackingNumbers,
      }));
      const merged = mergeEmailImportRows(inputs);
      // Emails that gave nothing to import (no order number, not an order
      // confirmation) stay in the inbox.
      const used = toImport.filter((r, i) => inputs[i].kind === 'ordered' || /\d/.test(inputs[i].orderNumber));

      let data: { imported?: number; updated?: number; skipped?: number; skippedNoMatch?: number; skippedCancelled?: number } = {};
      if (merged.rows.length) {
        const res = await fetch('/api/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(merged.rows),
        });
        if (!res.ok) {
          setError(`Import failed: ${await res.text() || res.status}`);
          return;
        }
        data = await res.json();
      }

      // Importing from a new store teaches the tracker its email domain, so its
      // next emails import on their own under this name.
      const stores = new Map<string, string>();
      for (const r of used) {
        const name = r.store.trim();
        if (r.platform !== 'Unknown' || !r.merchant?.domain || !name) continue;
        if (!r.merchant.known || name !== r.merchant.platform) stores.set(r.merchant.domain, name);
      }
      for (const [domain, name] of stores) {
        await fetch('/api/email/merchants', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain, name }),
        }).catch(() => {});
      }

      let delOk = true;
      if (used.length) {
        const delRes = await fetch('/api/email/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uids: used.map(r => r.uid) }),
        });
        delOk = delRes.ok;
      }

      setImported({
        count: data.imported ?? 0,
        updated: data.updated ?? 0,
        skipped: data.skipped ?? 0,
        noMatch: data.skippedNoMatch ?? 0,
        cancelled: data.skippedCancelled ?? 0,
        dropped: merged.dropped,
      });
      const usedUids = new Set(used.map(r => r.uid));
      setRows(prev => prev.filter(r => !usedUids.has(r.uid)));
      if (!delOk) {
        setError('Orders imported but deleting the emails from the inbox failed — they may reappear on next sync.');
      }
    } finally {
      setImporting(false);
    }
  }

  const selected = rows.filter(r => r.selected);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <label className="text-gray-400 text-xs whitespace-nowrap">How far back:</label>
          <select
            value={syncWindow}
            onChange={e => setSyncWindow(e.target.value as typeof syncWindow)}
            disabled={syncing}
            className="input text-xs py-1 w-28"
          >
            <option value="3m">3 months</option>
            <option value="6m">6 months</option>
            <option value="1y">1 year</option>
            <option value="all">All time</option>
          </select>
        </div>
        <button
          onClick={sync}
          disabled={syncing}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm px-4 py-2 rounded-md transition-colors"
        >
          {syncing ? 'Connecting to inbox…' : 'Sync Inbox'}
        </button>
        <p className="text-gray-500 text-xs">
          Reads the order inbox: Amazon, Walmart, Costco and BuyingGroup emails, sent there or forwarded.
          New order, shipping and delivery emails are imported automatically every 5 minutes; anything listed here was left for you to check.
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
          Imported {imported.count} new order{imported.count !== 1 ? 's' : ''}
          {imported.updated > 0 && <>, updated {imported.updated}</>}; emails removed from the inbox.
          {imported.skipped > 0 && (
            <span className="text-yellow-400 ml-2">
              · {imported.skipped} duplicate{imported.skipped !== 1 ? 's' : ''} skipped.
            </span>
          )}
          {imported.noMatch > 0 && (
            <span className="text-yellow-400 ml-2">
              · {imported.noMatch} shipping/delivery email{imported.noMatch !== 1 ? 's' : ''} had no matching order.
            </span>
          )}
          {imported.cancelled > 0 && (
            <span className="text-yellow-400 ml-2">
              · {imported.cancelled} cancellation{imported.cancelled !== 1 ? 's' : ''} had no matching order.
            </span>
          )}
          {imported.dropped > 0 && (
            <span className="text-yellow-400 ml-2">
              · {imported.dropped} email{imported.dropped !== 1 ? 's' : ''} without an order number left in the inbox.
            </span>
          )}
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
                  <th className="px-3 py-2 text-left">Subject / Address</th>
                  <th className="px-3 py-2 text-right w-24">Cost</th>
                  <th className="px-3 py-2 text-right w-24">Cashback</th>
                  <th className="px-3 py-2 text-right w-28">Sale Price *</th>
                  <th className="px-3 py-2 text-left">Buyer</th>
                  <th className="px-3 py-2 text-left">Card</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {rows.map((r, i) => {
                  const hasAddress = !!r.shippingAddress;
                  const isAssigned = !!r.buyerId;

                  return (
                    <tr key={r.uid} className={r.selected ? 'hover:bg-gray-900/40' : 'opacity-40'}>
                      <td className="px-3 py-2">
                        <input type="checkbox" checked={r.selected}
                          onChange={e => updateRow(i, 'selected', e.target.checked)}
                          className="accent-blue-500" />
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {r.platform === 'Unknown' ? (
                            <>
                              <input
                                value={r.store}
                                onChange={e => updateRow(i, 'store', e.target.value)}
                                placeholder="Store name"
                                title={r.merchant?.domain ? `Emails from ${r.merchant.domain} import under this name` : 'Store name'}
                                className="w-28 px-1.5 py-0.5 rounded text-xs bg-gray-800 border border-gray-700 text-gray-200"
                              />
                              {r.merchant && !r.merchant.known && (
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-amber-900/40 text-amber-300" title="Import once and the tracker learns this store">
                                  new store
                                </span>
                              )}
                            </>
                          ) : (
                            <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${PLATFORM_BADGE[r.platform] ?? PLATFORM_BADGE.Unknown}`}>
                              {r.platform}
                            </span>
                          )}
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs ${KIND_BADGE[r.kind] ?? KIND_BADGE.other}`}>
                            {r.kind}
                          </span>
                          {r.forwarded && (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-gray-800 text-gray-400" title="Forwarded to the order inbox">Fwd</span>
                          )}
                          {r.routing === 'unassigned' && (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-amber-900/40 text-amber-300" title="No user's Email Routing address matches this email">unassigned</span>
                          )}
                          {r.routing === 'ambiguous' && (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-amber-900/40 text-amber-300" title="More than one user's Email Routing address matches this email">2+ users</span>
                          )}
                        </div>
                        {r.trackingNumbers.length > 0 && (
                          <div className="text-xs text-gray-500 font-mono mt-0.5 truncate max-w-[140px]" title={r.trackingNumbers.join(', ')}>
                            {r.trackingNumbers.length === 1 ? r.trackingNumbers[0] : `${r.trackingNumbers.length} tracking #s`}
                          </div>
                        )}
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
                        {hasAddress ? (
                          <div className="relative mt-0.5">
                            <button
                              onClick={() => setOpenPopover(openPopover === i ? null : i)}
                              title={r.shippingAddress}
                              className={`text-left text-xs truncate max-w-full transition-colors ${
                                isAssigned
                                  ? 'text-green-600 hover:text-green-400'
                                  : 'text-blue-600 hover:text-blue-400 underline decoration-dashed'
                              }`}
                            >
                              {isAssigned ? '✓ ' : ''}{r.shippingAddress}
                            </button>
                            {openPopover === i && (
                              <AddressPopover
                                address={r.shippingAddress}
                                buyers={buyers}
                                onAssign={(bid, bname) => handleAssign(i, bid, bname)}
                                onClose={() => setOpenPopover(null)}
                              />
                            )}
                          </div>
                        ) : r.rawSnippet ? (
                          <div className="truncate text-gray-600 text-xs mt-0.5" title={r.rawSnippet}>
                            {r.rawSnippet.slice(0, 80)}
                          </div>
                        ) : null}
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
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex items-center gap-4">
            <button
              onClick={handleImport}
              disabled={importing || selected.length === 0}
              className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-5 py-2 rounded-md text-sm transition-colors"
            >
              {importing ? 'Importing…' : `Import ${selected.length} Email${selected.length !== 1 ? 's' : ''} + Trash Them`}
            </button>
            <p className="text-xs text-gray-500">Emails for the same order become one order. Imported emails leave the inbox (Gmail: moved to Trash, emptied after 30 days; Cloudflare: deleted).</p>
          </div>
        </>
      )}

      {!syncing && rows.length === 0 && !error && (
        <div className="rounded-lg border border-dashed border-gray-700 py-10 text-center text-gray-500 text-sm">
          <p>Click "Sync Inbox" to scan the order inbox for order emails.</p>
          <p className="text-xs mt-1 text-gray-600">Shows your emails (by your addresses under Email Routing) and ones no user claims yet.</p>
        </div>
      )}
    </div>
  );
}
