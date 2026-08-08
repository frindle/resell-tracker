'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import CommitNumberInput from '@/components/CommitNumberInput';

import { RETURN_STATUSES as ITEM_STATUSES, RETURN_STATUS_LABELS as ITEM_STATUS_LABELS, type ReturnStatus as ItemReturnStatus } from '@/lib/returnStatus';

const ITEM_STATUS_STYLES: Record<ItemReturnStatus, string> = {
  requested: 'bg-orange-900/50 text-orange-300',
  in_transit: 'bg-blue-900/50 text-blue-300',
  received: 'bg-blue-900/50 text-blue-300',
  refunded: 'bg-green-900/50 text-green-300',
  rejected: 'bg-red-900/50 text-red-300',
};

type Line = {
  key: string;
  itemName: string;
  trackingNumber: string | null;
  quantity: number;
  returnedQuantity: number;
};

type ItemReturn = {
  id: number;
  itemName: string;
  trackingNumber: string | null;
  quantity: number;
  status: string;
  refundAmount: number | null;
  requestedAt: string | null;
};

type ReturnsPayload = {
  lines: Line[];
  returns: ItemReturn[];
  order: { cost: number; shippingCost: number; insuranceCost: number; returnedCost: number; salePrice: number | null } | null;
};

type Props = {
  orderId: number;
  locked: boolean;
};

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

export default function ReturnPanel({ orderId, locked }: Props) {
  const router = useRouter();

  const [data, setData] = useState<ReturnsPayload | null>(null);
  const [itemError, setItemError] = useState('');
  const [savingItem, setSavingItem] = useState(false);
  const [draftLine, setDraftLine] = useState('');
  const [draftQty, setDraftQty] = useState(1);
  const [draftStatus, setDraftStatus] = useState<ItemReturnStatus>('requested');
  // Most orders never get returned -- the full panel used to render
  // unconditionally at the top of every order page regardless. Still
  // mounted/reachable on every order (per the comment above, that's the
  // whole point), but collapsed to a small link by default when there's no
  // existing return activity. Any order with real return data still shows
  // the full panel outright -- nothing worth seeing gets hidden.
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/orders/${orderId}/returns`);
    if (res.ok) setData(await res.json() as ReturnsPayload);
  }, [orderId]);

  useEffect(() => { load(); }, [load]);

  async function callReturns(method: 'POST' | 'PATCH' | 'DELETE', body: Record<string, unknown>) {
    setSavingItem(true);
    setItemError('');
    try {
      const res = await fetch(`/api/orders/${orderId}/returns`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await res.json() as ReturnsPayload & { error?: string };
      if (!res.ok || d.error) { setItemError(d.error ?? 'Failed'); return false; }
      setData(d);
      // Sale price / cost basis moved — pull the server-rendered numbers back in.
      router.refresh();
      return true;
    } catch (e) {
      setItemError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setSavingItem(false);
    }
  }

  const lines = data?.lines ?? [];
  const returns = data?.returns ?? [];
  const openLines = lines.filter(l => l.quantity - l.returnedQuantity > 0);
  const selectedLine = lines.find(l => l.key === draftLine) ?? openLines[0];
  const maxQty = selectedLine ? selectedLine.quantity - selectedLine.returnedQuantity : 0;

  const totalUnits = lines.reduce((s, l) => s + l.quantity, 0);
  const returnedUnits = lines.reduce((s, l) => s + l.returnedQuantity, 0);
  const grossCost = data?.order ? data.order.cost + data.order.shippingCost + data.order.insuranceCost : 0;
  const netCost = grossCost - (data?.order?.returnedCost ?? 0);

  const itemReturnsBlock = (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium text-gray-300">Returned items</h2>
        {totalUnits > 0 && (
          <span className="text-xs text-gray-500">
            {totalUnits - returnedUnits} of {totalUnits} unit{totalUnits === 1 ? '' : 's'} still sold
          </span>
        )}
      </div>

      {returns.length > 0 && (
        <div className="space-y-2">
          {returns.map(r => {
            const st = (ITEM_STATUSES as readonly string[]).includes(r.status)
              ? r.status as ItemReturnStatus : 'requested';
            return (
              <div key={r.id} className="bg-gray-950/60 border border-gray-800 rounded-md p-2.5 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm text-white truncate">
                      {r.quantity} × {r.itemName}
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      <span className={`inline-flex items-center px-1.5 py-0.5 rounded font-medium ${ITEM_STATUS_STYLES[st]} mr-2`}>
                        {ITEM_STATUS_LABELS[st]}
                      </span>
                      {r.trackingNumber && <span className="font-mono mr-2">{r.trackingNumber}</span>}
                      {r.requestedAt && <span>requested {new Date(r.requestedAt).toLocaleDateString()}</span>}
                    </div>
                  </div>
                  {!locked && (
                    <button
                      onClick={() => { if (confirm('Delete this return record? The units go back to being counted as sold.')) callReturns('DELETE', { returnId: r.id }); }}
                      disabled={savingItem}
                      title="Delete return record"
                      className="text-xs text-gray-500 hover:text-red-400 px-2 py-1 shrink-0"
                    >✕</button>
                  )}
                </div>
                {!locked && (
                  <div className="flex flex-wrap items-center gap-3 text-xs">
                    <label className="flex items-center gap-1 text-gray-400">
                      Status:
                      <select
                        value={st}
                        onChange={e => callReturns('PATCH', { returnId: r.id, status: e.target.value })}
                        disabled={savingItem}
                        className="bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-xs text-white focus:outline-none focus:border-blue-500"
                      >
                        {ITEM_STATUSES.map(s => <option key={s} value={s}>{ITEM_STATUS_LABELS[s]}</option>)}
                      </select>
                    </label>
                    {st === 'refunded' && (
                      <label className="flex items-center gap-1 text-gray-400">
                        Refund $:
                        <CommitNumberInput
                          step="0.01"
                          min={0}
                          value={r.refundAmount}
                          onCommit={v => callReturns('PATCH', { returnId: r.id, refundAmount: v })}
                          placeholder="actual"
                          className="bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-xs text-white w-20 focus:outline-none focus:border-blue-500"
                        />
                      </label>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {data?.order && (returnedUnits > 0 || returns.length > 0) && (
        <p className="text-xs text-gray-500">
          Purchase price {fmt(grossCost)} → effective <span className="text-gray-300">{fmt(netCost)}</span>
          {' · '}sale price {data.order.salePrice != null ? fmt(data.order.salePrice) : '—'} (remaining units only)
        </p>
      )}

      {!locked && openLines.length > 0 && (
        <div className="flex flex-wrap items-end gap-2 pt-1 border-t border-gray-800">
          <label className="text-xs text-gray-400">
            Item
            <select
              value={selectedLine?.key ?? ''}
              onChange={e => { setDraftLine(e.target.value); setDraftQty(1); }}
              className="block bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-white mt-0.5 max-w-xs focus:outline-none focus:border-blue-500"
            >
              {openLines.map(l => (
                <option key={l.key} value={l.key}>
                  {l.itemName} ({l.quantity - l.returnedQuantity} of {l.quantity} left{l.trackingNumber ? ` · ${l.trackingNumber}` : ''})
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-gray-400">
            Qty <span className="text-gray-500">(of {maxQty})</span>
            <CommitNumberInput
              integer
              min={1}
              value={draftQty}
              onCommit={v => setDraftQty(Math.min(maxQty, v ?? 1))}
              className="block bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-white w-16 mt-0.5 focus:outline-none focus:border-blue-500"
            />
          </label>
          <label className="text-xs text-gray-400">
            Status
            <select
              value={draftStatus}
              onChange={e => setDraftStatus(e.target.value as ItemReturnStatus)}
              className="block bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-white mt-0.5 focus:outline-none focus:border-blue-500"
            >
              {ITEM_STATUSES.map(s => <option key={s} value={s}>{ITEM_STATUS_LABELS[s]}</option>)}
            </select>
          </label>
          <button
            onClick={async () => {
              const ok = await callReturns('POST', {
                lineKey: selectedLine?.key,
                quantity: draftQty,
                status: draftStatus,
              });
              if (ok) { setDraftQty(1); setDraftStatus('requested'); }
            }}
            disabled={savingItem || !selectedLine || maxQty < 1}
            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm px-3 py-1 rounded transition-colors"
          >
            {savingItem ? 'Saving…' : 'Record return'}
          </button>
        </div>
      )}

      {!locked && openLines.length === 0 && lines.length > 0 && (
        <p className="text-xs text-gray-500">All units on this order are already recorded as returned.</p>
      )}
      {locked && <p className="text-xs text-gray-500">Unlock order to record returns.</p>}
      {itemError && <p className="text-xs text-red-400">{itemError}</p>}
    </div>
  );

  if (returns.length === 0 && !expanded && data !== null) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
      >
        + Record a return
      </button>
    );
  }
  if (data === null) return null; // avoid a flash of the collapsed link before the first load resolves

  return itemReturnsBlock;
}

