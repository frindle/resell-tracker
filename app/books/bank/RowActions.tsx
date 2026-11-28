'use client';

import { useEffect, useRef, useState } from 'react';
import { money } from '../ui';
import { acceptOptions, linkBody } from '@/lib/books/bank/acceptOptions';
import { isOpenTxn, type Txn } from './txnTypes';

export type RowHandlers = {
  act: (id: number, body: Record<string, unknown>) => unknown;
  startPick: (t: Txn) => unknown;
  startRule: (t: Txn) => unknown;
  startCost: (t: Txn) => unknown;
  startSplit: (t: Txn) => unknown;
};

/**
 * The buttons of a bank row: the Accept options, Personal and More (link to an order, pick orders, rule, cost entry, ignore), or Undo.
 * The table shows More as a dropdown; the review card passes `inline` and shows it open.
 */
export default function RowActions({ t, h, inline = false }: { t: Txn; h: RowHandlers; inline?: boolean }) {
  const { act, startPick, startRule, startCost, startSplit } = h;
  const [open, setOpen] = useState(false);
  const [linkTo, setLinkTo] = useState('');
  const ref = useRef<HTMLSpanElement>(null);
  // The dropdown closes on Esc, a click outside it, its x or any action in it.
  useEffect(() => {
    if (!open || inline) return;
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open, inline]);
  const sg = t.matchStatus === 'suggested' ? t.suggestion : null;
  const isOpen = isOpenTxn(t);
  const menu = (
    <>
      {t.amountCents !== 0 && <form className="flex gap-1" onSubmit={e => { e.preventDefault(); if (linkTo.trim()) { setOpen(false); act(t.id, linkBody(linkTo)); } }}>
        <input className="input w-52" value={linkTo} onChange={e => setLinkTo(e.target.value)}
          placeholder={t.amountCents < 0 ? 'order no., #id or t#row' : 'order no., #id, r#return or t#row'} />
        <button className="text-blue-400">Link</button>
      </form>}
      {t.amountCents > 0 && t.depositable && <button className="text-blue-400 block" onClick={() => startPick(t)}>Pick orders this paid</button>}
      {t.amountCents > 0 && t.mapped && <button className="text-blue-400 block" onClick={() => { if (confirm('Link this credit as a Darkbloom payout?')) act(t.id, { action: 'darkbloom' }); }}>Darkbloom payout</button>}
      <button className="text-blue-400 block" onClick={() => startRule(t)}>Make a rule from this</button>
      {t.amountCents < 0 && t.mapped && <button className="text-blue-400 block" onClick={() => startCost(t)}>Make a cost entry</button>}
      {t.amountCents !== 0 && <button className="text-blue-400 block" onClick={() => startSplit(t)}>Split into parts</button>}
      <div className="text-gray-500 max-w-56">{t.amountCents < 0 ? 'Pays part or all of one order.' : 'Part or all of a return\'s refund.'}</div>
      {t.mapped
        ? <>
            <div className="text-amber-300 max-w-56">This account is in your books. Ignoring hides real money; use Personal or link it. Duplicates only.</div>
            <button className="text-gray-300 block" onClick={() => { if (confirm('Mark this row a duplicate of another row and ignore it?')) act(t.id, { action: 'ignore', duplicate: true }); }}>Ignore (duplicate)</button>
          </>
        : <button className="text-gray-300 block" onClick={() => act(t.id, { action: 'ignore' })}>Ignore</button>}
    </>
  );
  return (
    <div className="flex flex-wrap gap-2 text-xs">
      {(() => { const opts = acceptOptions(sg, money); return opts.map((o, i) => <button key={o.key} className="text-blue-400" onClick={() => act(t.id, o.body)}>{inline && opts.length > 1 ? `${i + 1}. ` : ''}{o.label}</button>); })()}
      {isOpen && <>
        <button className="text-amber-300" onClick={() => act(t.id, { action: 'personal' })}>Personal</button>
        {inline
          ? <div className="basis-full space-y-1 border-t border-gray-800 pt-2 mt-1">{menu}</div>
          : <span ref={ref} className="relative inline-block" data-more>
              <button className="text-gray-400" aria-expanded={open} onClick={() => setOpen(o => !o)}>{open ? '▾' : '▸'} More</button>
              {open && <div className="absolute right-0 top-full mt-1 w-72 max-w-[85vw] bg-gray-900 border border-gray-700 rounded-md p-2 pr-6 space-y-1 z-20 text-left whitespace-normal"
                onClick={e => { const b = (e.target as Element).closest('button'); if (b && !b.closest('form')) setOpen(false); }}>
                <button className="absolute top-1 right-2 text-gray-400 hover:text-gray-200" aria-label="Close" title="Close (Esc)">×</button>
                {menu}
              </div>}
            </span>}
      </>}
      {(t.matchStatus === 'matched' || t.matchStatus === 'ignored') && <button className="text-gray-400" onClick={() => act(t.id, { action: 'reset' })}>Undo</button>}
    </div>
  );
}
