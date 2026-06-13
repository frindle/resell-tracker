'use client';

import { useEffect, useState } from 'react';

type DealItem = {
  item_id: number;
  item_name?: string;
  max_can_reserve: number;
  is_reservation_closed: number;
  remaining_reservations: number;
};

type Watcher = {
  id: number;
  dealSlug: string;
  dealTitle: string | null;
  itemId: number;
  itemName: string | null;
  qty: number;
  active: boolean;
  lastChecked: string | null;
  lastResult: string | null;
  reservedAt: string | null;
  createdAt: string;
};

function fmtTime(s: string | null) {
  if (!s) return '—';
  return new Date(s).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function slugFromInput(raw: string) {
  try {
    const url = new URL(raw.trim());
    const parts = url.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] ?? '';
  } catch {
    return raw.trim();
  }
}

export default function WatcherPage() {
  const [watchers, setWatchers] = useState<Watcher[]>([]);
  const [loadingWatchers, setLoadingWatchers] = useState(true);

  // Add form state
  const [dealInput, setDealInput] = useState('');
  const [loadingDeal, setLoadingDeal] = useState(false);
  const [dealError, setDealError] = useState('');
  const [dealTitle, setDealTitle] = useState('');
  const [dealItems, setDealItems] = useState<DealItem[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null);
  const [qty, setQty] = useState(1);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');

  function loadWatchers() {
    fetch('/api/bfmr/watchers')
      .then(r => r.json())
      .then(setWatchers)
      .finally(() => setLoadingWatchers(false));
  }

  useEffect(() => {
    loadWatchers();
    const t = setInterval(loadWatchers, 15_000);
    return () => clearInterval(t);
  }, []);

  async function lookupDeal() {
    const slug = slugFromInput(dealInput);
    if (!slug) return;
    setLoadingDeal(true);
    setDealError('');
    setDealItems([]);
    setSelectedItemId(null);
    try {
      const res = await fetch(`/api/bfmr/deal-items?slug=${encodeURIComponent(slug)}`);
      if (!res.ok) { setDealError(await res.text()); return; }
      const data = await res.json() as { dealTitle: string; items: DealItem[] };
      setDealTitle(data.dealTitle);
      setDealItems(data.items);
      if (data.items.length === 1) setSelectedItemId(data.items[0].item_id);
    } catch (e) {
      setDealError(String(e));
    } finally {
      setLoadingDeal(false);
    }
  }

  async function addWatcher() {
    if (!selectedItemId) return;
    const slug = slugFromInput(dealInput);
    setAdding(true);
    setAddError('');
    try {
      const res = await fetch('/api/bfmr/watchers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dealSlug: slug, itemId: selectedItemId, qty }),
      });
      if (!res.ok) { setAddError(await res.text()); return; }
      setDealInput('');
      setDealTitle('');
      setDealItems([]);
      setSelectedItemId(null);
      setQty(1);
      loadWatchers();
    } catch (e) {
      setAddError(String(e));
    } finally {
      setAdding(false);
    }
  }

  async function deleteWatcher(id: number) {
    await fetch(`/api/bfmr/watchers/${id}`, { method: 'DELETE' });
    setWatchers(prev => prev.filter(w => w.id !== id));
  }

  async function toggleWatcher(id: number, active: boolean) {
    const res = await fetch(`/api/bfmr/watchers/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active }),
    });
    if (res.ok) {
      const updated = await res.json() as Watcher;
      setWatchers(prev => prev.map(w => w.id === id ? updated : w));
    }
  }

  const active = watchers.filter(w => w.active);
  const done = watchers.filter(w => !w.active);

  return (
    <div className="space-y-8 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold">Deal Watcher</h1>
        <p className="text-gray-400 text-sm mt-1">
          Polls every 2 minutes. Fires a Pushover notification and stops when a slot opens.
        </p>
      </div>

      {/* Add watcher */}
      <section className="rounded-lg border border-gray-800 p-5 space-y-4">
        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">Watch a Deal</h2>

        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Deal URL or slug"
            value={dealInput}
            onChange={e => { setDealInput(e.target.value); setDealItems([]); setSelectedItemId(null); setDealError(''); }}
            onKeyDown={e => e.key === 'Enter' && lookupDeal()}
            className="flex-1 bg-gray-900 border border-gray-700 rounded-md px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
          />
          <button
            onClick={lookupDeal}
            disabled={!dealInput.trim() || loadingDeal}
            className="bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white text-sm px-4 py-2 rounded-md transition-colors"
          >
            {loadingDeal ? 'Loading…' : 'Load'}
          </button>
        </div>

        {dealError && <p className="text-red-400 text-sm">{dealError}</p>}

        {dealItems.length > 0 && (
          <div className="space-y-3">
            <p className="text-sm font-medium text-gray-200">{dealTitle}</p>

            <div className="space-y-2">
              {dealItems.map(item => (
                <label key={item.item_id} className="flex items-start gap-3 cursor-pointer group">
                  <input
                    type="radio"
                    name="item"
                    checked={selectedItemId === item.item_id}
                    onChange={() => setSelectedItemId(item.item_id)}
                    className="mt-0.5"
                  />
                  <div className="flex-1 text-sm">
                    <span className="text-gray-200">{item.item_name ?? `Item ${item.item_id}`}</span>
                    <span className="ml-2 text-xs text-gray-500">
                      {item.is_reservation_closed === 1
                        ? <span className="text-red-400">Closed</span>
                        : item.max_can_reserve > 0
                          ? <span className="text-green-400">{item.max_can_reserve} available to you · {item.remaining_reservations} remaining</span>
                          : <span className="text-yellow-400">Open but you're at cap</span>}
                    </span>
                  </div>
                </label>
              ))}
            </div>

            <div className="flex items-center gap-3">
              <label className="text-xs text-gray-400">Qty to reserve</label>
              <input
                type="number"
                min={1}
                value={qty}
                onChange={e => setQty(Math.max(1, parseInt(e.target.value) || 1))}
                className="w-16 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
              />
              <button
                onClick={addWatcher}
                disabled={!selectedItemId || adding}
                className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm px-4 py-2 rounded-md transition-colors"
              >
                {adding ? 'Adding…' : 'Watch'}
              </button>
              {addError && <span className="text-red-400 text-xs">{addError}</span>}
            </div>
          </div>
        )}
      </section>

      {/* Active watchers */}
      {loadingWatchers ? (
        <p className="text-gray-500 text-sm">Loading…</p>
      ) : (
        <>
          {active.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">Watching ({active.length})</h2>
              <div className="rounded-lg border border-gray-800 divide-y divide-gray-800">
                {active.map(w => (
                  <div key={w.id} className="px-4 py-3 flex items-start justify-between gap-3">
                    <div className="space-y-0.5 min-w-0">
                      <p className="text-sm font-medium text-gray-200 truncate">{w.dealTitle ?? w.dealSlug}</p>
                      {w.itemName && <p className="text-xs text-gray-500 truncate">{w.itemName}</p>}
                      <p className="text-xs text-gray-600">
                        Qty {w.qty} · Last checked {fmtTime(w.lastChecked)} · {w.lastResult ?? 'Pending first check'}
                      </p>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <button onClick={() => toggleWatcher(w.id, false)} className="text-xs text-gray-500 hover:text-yellow-400 transition-colors">Pause</button>
                      <button onClick={() => deleteWatcher(w.id)} className="text-xs text-gray-500 hover:text-red-400 transition-colors">Remove</button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {active.length === 0 && done.length === 0 && (
            <div className="rounded-lg border border-dashed border-gray-700 py-10 text-center text-gray-500 text-sm">
              No watchers yet. Paste a deal URL above to get started.
            </div>
          )}

          {done.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Completed / Paused</h2>
              <div className="rounded-lg border border-gray-800 divide-y divide-gray-800">
                {done.map(w => (
                  <div key={w.id} className="px-4 py-3 flex items-start justify-between gap-3 opacity-60">
                    <div className="space-y-0.5 min-w-0">
                      <p className="text-sm font-medium text-gray-300 truncate">{w.dealTitle ?? w.dealSlug}</p>
                      {w.itemName && <p className="text-xs text-gray-500 truncate">{w.itemName}</p>}
                      <p className="text-xs text-gray-500">
                        {w.reservedAt
                          ? <span className="text-green-500">Reserved at {new Date(w.reservedAt).toLocaleString()}</span>
                          : `Paused · ${w.lastResult ?? ''}`}
                      </p>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      {!w.reservedAt && (
                        <button onClick={() => toggleWatcher(w.id, true)} className="text-xs text-gray-500 hover:text-blue-400 transition-colors">Resume</button>
                      )}
                      <button onClick={() => deleteWatcher(w.id)} className="text-xs text-gray-500 hover:text-red-400 transition-colors">Remove</button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
