'use client';

import { useEffect, useState } from 'react';
import { money } from '../ui';
import { acceptOptions } from '@/lib/books/bank/acceptOptions';
import RowActions, { type RowHandlers } from './RowActions';
import TxnStatus from './TxnStatus';
import { isOpenTxn, type Txn } from './txnTypes';

/**
 * Step through the open (unmatched or suggested) rows one at a time. The queue is taken when the tab opens; a row that is
 * acted on (or matched meanwhile) drops out by itself, Skip and Back only move. Skips last for the session.
 * Keys: Right or S skip, Left back, P personal, A accept (one option), 1-9 the nth accept option, Esc leaves.
 */
export default function Review({ rows, h, busy, paused, onExit }: { rows: Txn[] | null; h: RowHandlers; busy: boolean; paused: boolean; onExit: () => void }) {
  const [queue, setQueue] = useState<number[] | null>(null);
  const [pos, setPos] = useState(0);
  if (queue === null && rows) setQueue(rows.filter(isOpenTxn).map(t => t.id));

  const byId = new Map((rows ?? []).map(t => [t.id, t]));
  const openAt = (i: number) => { const t = byId.get(queue?.[i] ?? -1); return t && isOpenTxn(t) ? t : null; };
  let curIdx = -1;
  if (queue) for (let i = pos; i < queue.length; i++) if (openAt(i)) { curIdx = i; break; }
  let prevIdx = -1;
  if (queue) for (let i = Math.min(curIdx === -1 ? queue.length : curIdx, queue.length) - 1; i >= 0; i--) if (openAt(i)) { prevIdx = i; break; }
  const cur = curIdx >= 0 ? openAt(curIdx) : null;
  const skip = () => { if (queue && cur) setPos(curIdx + 1); };
  const back = () => { if (prevIdx >= 0) setPos(prevIdx); };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
      if (e.key === 'Escape') { onExit(); return; }
      if (paused || busy) return;
      const k = e.key.toLowerCase();
      if (k === 'arrowright' || k === 's') { e.preventDefault(); skip(); }
      else if (k === 'arrowleft') { e.preventDefault(); back(); }
      else if (!cur) return;
      else if (k === 'p') { e.preventDefault(); h.act(cur.id, { action: 'personal' }); }
      else if (/^[1-9]$/.test(k) || k === 'a') {
        const opts = acceptOptions(cur.matchStatus === 'suggested' ? cur.suggestion : null, money);
        const o = k === 'a' ? (opts.length === 1 ? opts[0] : undefined) : opts[Number(k) - 1];
        if (o) { e.preventDefault(); h.act(cur.id, o.body); }
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  });

  if (!queue) return <div className="text-sm text-gray-500">Loading...</div>;
  const nav = (
    <div className="flex gap-3 text-xs">
      <button className="text-gray-300 border border-gray-600 rounded-md px-2 py-0.5 disabled:opacity-40" disabled={prevIdx < 0} onClick={back}>Back</button>
      <button className="text-gray-300 border border-gray-600 rounded-md px-2 py-0.5 disabled:opacity-40" disabled={!cur} onClick={skip}>Skip</button>
      <button className="text-gray-400" onClick={onExit}>Leave review</button>
    </div>
  );
  if (!cur) return (
    <div className="space-y-3 text-sm">
      <div className="text-gray-300">{queue.length === 0 ? 'Nothing is waiting for review.' : 'You are at the end of the list.'}</div>
      <div className="flex gap-3 items-center">{nav}
        {queue.length > 0 && <button className="text-blue-400 text-xs" onClick={() => { setQueue(null); setPos(0); }}>Start over with what is still open</button>}</div>
    </div>
  );
  const left = queue.filter((_, i) => openAt(i)).length;
  return (
    <div className="space-y-3 text-sm max-w-2xl">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-gray-300">{curIdx + 1} of {queue.length} <span className="text-gray-500">({left} still open)</span></div>
        {nav}
      </div>
      <div className="border border-gray-700 rounded-md p-4 space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <div className="text-gray-300">{cur.postedDate}{cur.pending ? ' (pending)' : ''} · {cur.accountName} · <span className="text-gray-500">t#{cur.id}</span></div>
          <div className={`text-lg font-medium ${cur.amountCents < 0 ? 'text-red-300' : 'text-green-300'}`}>{money(cur.amountCents)}</div>
        </div>
        <div className="text-white break-words">{cur.description}</div>
        <TxnStatus t={cur} />
        <RowActions key={cur.id} t={cur} h={h} inline />
      </div>
      <div className="text-xs text-gray-500">Keys: Right or S skip, Left back, P personal, A accept (when there is one option), 1-9 the numbered accept option, Esc leave.</div>
    </div>
  );
}
