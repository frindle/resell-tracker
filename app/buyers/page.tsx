'use client';

import { useEffect, useState } from 'react';

type BuyerAddress = { id: number; label: string; pattern: string };
type BlockedAddress = { id: number; label: string; pattern: string };

type Buyer = {
  id: number;
  name: string;
  createdAt: string;
  orderCount: number;
  totalPaid: number;
  lastOrderDate: string | null;
  addresses: BuyerAddress[];
};

type OrderRow = {
  id: number;
  orderDate: string;
  platform: string;
  orderNumber: string | null;
  itemDescription: string | null;
  cost: number;
  salePrice: number | null;
};

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function PayoutHistory({ buyerId }: { buyerId: number }) {
  const [orders, setOrders] = useState<OrderRow[] | null>(null);

  useEffect(() => {
    fetch(`/api/buyers/${buyerId}/orders`)
      .then(r => r.json())
      .then(setOrders)
      .catch(() => setOrders([]));
  }, [buyerId]);

  if (orders === null) {
    return <div className="px-4 py-3 text-xs text-gray-600">Loading…</div>;
  }
  if (orders.length === 0) {
    return <div className="px-4 py-3 text-xs text-gray-600">No paid orders recorded for this group yet.</div>;
  }

  return (
    <div className="divide-y divide-gray-800">
      {orders.map(o => (
        <div key={o.id} className="px-4 py-2 flex items-center gap-4 text-xs">
          <span className="text-gray-500 w-20 shrink-0">
            {new Date(o.orderDate).toLocaleDateString()}
          </span>
          <span className="text-gray-500 w-16 shrink-0">{o.platform}</span>
          <span className="text-gray-400 flex-1 truncate" title={o.itemDescription ?? ''}>
            {o.itemDescription || o.orderNumber || '—'}
          </span>
          <span className="text-gray-500 w-20 text-right shrink-0">cost {fmt(o.cost)}</span>
          <span className="text-green-400 w-20 text-right font-medium shrink-0">
            {fmt(o.salePrice ?? 0)}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function BuyersPage() {
  const [buyers, setBuyers] = useState<Buyer[]>([]);
  const [blocked, setBlocked] = useState<BlockedAddress[]>([]);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [openHistory, setOpenHistory] = useState<number | null>(null);
  const [openAddresses, setOpenAddresses] = useState<number | null>(null);
  const [newPattern, setNewPattern] = useState('');
  const [newBlockedPattern, setNewBlockedPattern] = useState('');
  const [newBlockedLabel, setNewBlockedLabel] = useState('');
  const [applyingRules, setApplyingRules] = useState(false);
  const [lastApplyResult, setLastApplyResult] = useState<number | null>(null);

  function load() {
    fetch('/api/buyers').then(r => r.json()).then(setBuyers);
  }

  function loadBlocked() {
    fetch('/api/blocked-addresses').then(r => r.json()).then(setBlocked);
  }

  useEffect(() => { load(); loadBlocked(); }, []);

  async function add() {
    if (!name.trim()) return;
    setSaving(true);
    await fetch('/api/buyers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() }),
    });
    setName('');
    setSaving(false);
    load();
  }

  async function remove(id: number) {
    if (!confirm('Delete this group? Orders assigned to them will become unassigned.')) return;
    await fetch(`/api/buyers/${id}`, { method: 'DELETE' });
    load();
  }

  async function addAddress(buyerId: number) {
    const pattern = newPattern.trim();
    if (!pattern) return;
    await fetch('/api/shipping-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: pattern, pattern, buyerId }),
    });
    setNewPattern('');
    load();
  }

  async function removeAddress(ruleId: number) {
    await fetch(`/api/shipping-rules/${ruleId}`, { method: 'DELETE' });
    load();
  }

  async function addBlocked() {
    const pattern = newBlockedPattern.trim();
    if (!pattern) return;
    await fetch('/api/blocked-addresses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: newBlockedLabel.trim() || pattern, pattern }),
    });
    setNewBlockedPattern('');
    setNewBlockedLabel('');
    loadBlocked();
  }

  async function removeBlocked(id: number) {
    await fetch(`/api/blocked-addresses/${id}`, { method: 'DELETE' });
    loadBlocked();
  }

  async function applyRulesToExisting() {
    setApplyingRules(true);
    setLastApplyResult(null);
    try {
      const res = await fetch('/api/blocked-addresses/apply', { method: 'POST' });
      const data = await res.json();
      setLastApplyResult(data.flagged ?? 0);
    } finally {
      setApplyingRules(false);
    }
  }

  const totalAcrossAll = buyers.reduce((sum, b) => sum + b.totalPaid, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Buying Groups</h1>
        <p className="text-gray-400 text-sm mt-1">Track payouts per group over time</p>
      </div>

      <div className="flex gap-2 max-w-sm">
        <input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && add()}
          className="input flex-1"
          placeholder="Group name"
        />
        <button onClick={add} disabled={saving || !name.trim()} className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-4 py-2 rounded-md text-sm transition-colors">
          Add
        </button>
      </div>

      {buyers.length > 0 && totalAcrossAll > 0 && (
        <p className="text-sm text-gray-500">
          Total received across all groups:{' '}
          <span className="text-white font-medium">{fmt(totalAcrossAll)}</span>
        </p>
      )}

      <div className="space-y-3">
        {buyers.length === 0 && (
          <p className="text-gray-500 text-sm">No groups yet.</p>
        )}
        {buyers.map(b => {
          const histOpen = openHistory === b.id;
          const addrOpen = openAddresses === b.id;
          return (
            <div key={b.id} className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
              <div className="flex items-center gap-4 px-4 py-3">
                <span className="font-medium flex-1">{b.name}</span>

                <div className="flex items-center gap-6 text-sm">
                  <div className="text-right">
                    <div className="text-gray-500 text-xs">Orders</div>
                    <div className="text-gray-300">{b.orderCount}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-gray-500 text-xs">Total paid</div>
                    <div className={b.totalPaid > 0 ? 'text-green-400 font-medium' : 'text-gray-600'}>
                      {b.totalPaid > 0 ? fmt(b.totalPaid) : '—'}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-gray-500 text-xs">Last order</div>
                    <div className="text-gray-400 text-xs">
                      {b.lastOrderDate ? new Date(b.lastOrderDate).toLocaleDateString() : '—'}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-3 ml-2">
                  <button
                    onClick={() => {
                      setOpenAddresses(addrOpen ? null : b.id);
                      setOpenHistory(null);
                      setNewPattern('');
                    }}
                    className={`text-xs px-2 py-1 rounded transition-colors ${
                      addrOpen
                        ? 'bg-purple-900/50 text-purple-300'
                        : 'text-gray-500 hover:text-gray-300'
                    }`}
                  >
                    Addresses{b.addresses.length > 0 ? ` (${b.addresses.length})` : ''}
                  </button>
                  {b.orderCount > 0 && (
                    <button
                      onClick={() => {
                        setOpenHistory(histOpen ? null : b.id);
                        setOpenAddresses(null);
                      }}
                      className={`text-xs px-2 py-1 rounded transition-colors ${
                        histOpen
                          ? 'bg-blue-900/50 text-blue-300'
                          : 'text-gray-500 hover:text-gray-300'
                      }`}
                    >
                      History
                    </button>
                  )}
                  <button onClick={() => remove(b.id)} className="text-gray-600 hover:text-red-400 text-xs transition-colors">
                    Remove
                  </button>
                </div>
              </div>

              {addrOpen && (
                <div className="border-t border-gray-800 bg-gray-950 px-4 py-3 space-y-3">
                  <p className="text-xs text-gray-500">
                    Add the street address (or any unique part) of this group&apos;s warehouse.
                    Orders with a matching shipping address will be auto-assigned here on import.
                  </p>
                  <div className="flex gap-2 items-center">
                    <input
                      type="text"
                      value={newPattern}
                      onChange={e => setNewPattern(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && addAddress(b.id)}
                      placeholder="e.g. 1234 Warehouse Blvd or 60601"
                      className="input flex-1 text-sm py-1.5"
                    />
                    <button
                      onClick={() => addAddress(b.id)}
                      disabled={!newPattern.trim()}
                      className="bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white text-sm px-3 py-1.5 rounded-md transition-colors"
                    >
                      Add
                    </button>
                  </div>
                  {b.addresses.length === 0 ? (
                    <p className="text-xs text-gray-600">No addresses yet.</p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {b.addresses.map(a => (
                        <div key={a.id} className="flex items-center gap-2 bg-gray-800 border border-gray-700 rounded-md px-3 py-1 text-xs">
                          <span className="text-gray-300 font-mono">{a.pattern}</span>
                          <button
                            onClick={() => removeAddress(a.id)}
                            className="text-gray-600 hover:text-red-400 transition-colors"
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {histOpen && (
                <div className="border-t border-gray-800 bg-gray-950">
                  <div className="px-4 py-2 flex items-center gap-4 text-xs text-gray-600 font-medium uppercase tracking-wide border-b border-gray-800">
                    <span className="w-20">Date</span>
                    <span className="w-16">Platform</span>
                    <span className="flex-1">Item</span>
                    <span className="w-20 text-right">Cost</span>
                    <span className="w-20 text-right">Paid</span>
                  </div>
                  <PayoutHistory buyerId={b.id} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Blocked Addresses */}
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Blocked Addresses</h2>
            <p className="text-gray-400 text-sm mt-0.5">Orders shipped to these addresses are skipped on import (e.g. your home address). Manually imported orders are always exempt.</p>
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            <button
              onClick={applyRulesToExisting}
              disabled={applyingRules || blocked.length === 0}
              className="bg-red-900/60 hover:bg-red-800/60 disabled:opacity-40 text-red-200 text-sm px-3 py-1.5 rounded-md transition-colors whitespace-nowrap"
            >
              {applyingRules ? 'Applying…' : 'Apply Rules to Existing'}
            </button>
            {lastApplyResult !== null && (
              <span className="text-xs text-gray-400">{lastApplyResult === 0 ? 'No matching orders found.' : `${lastApplyResult} order${lastApplyResult !== 1 ? 's' : ''} flagged and hidden.`}</span>
            )}
          </div>
        </div>

        <div className="flex gap-2 flex-wrap">
          <input
            type="text"
            value={newBlockedLabel}
            onChange={e => setNewBlockedLabel(e.target.value)}
            placeholder="Label (optional)"
            className="input text-sm py-1.5 w-36"
          />
          <input
            type="text"
            value={newBlockedPattern}
            onChange={e => setNewBlockedPattern(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addBlocked()}
            placeholder="Address pattern to block"
            className="input flex-1 text-sm py-1.5 min-w-48"
          />
          <button
            onClick={addBlocked}
            disabled={!newBlockedPattern.trim()}
            className="bg-red-900/60 hover:bg-red-800/60 disabled:opacity-40 text-red-200 text-sm px-3 py-1.5 rounded-md transition-colors"
          >
            Block
          </button>
        </div>

        {blocked.length === 0 ? (
          <p className="text-gray-600 text-sm">No blocked addresses.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {blocked.map(b => (
              <div key={b.id} className="flex items-center gap-2 bg-red-950/40 border border-red-900/50 rounded-md px-3 py-1 text-xs">
                {b.label !== b.pattern && <span className="text-red-400 font-medium">{b.label}:</span>}
                <span className="text-gray-300 font-mono">{b.pattern}</span>
                <button onClick={() => removeBlocked(b.id)} className="text-gray-600 hover:text-red-400 transition-colors">✕</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
