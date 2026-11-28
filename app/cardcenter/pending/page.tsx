'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { groupByBrand, pickUnderPayout, type BrandGroup } from '@/lib/ccPending';

// Every gift card not yet sold to CardCenter, grouped by brand. Expand a
// brand, select cards (or the whole brand), and put them on the waitlist with
// a sell rate, a deadline and an optional payout cap. The waitlist runner then
// sells each card once CardCenter pays at least that rate. Nothing here sells
// a card directly except Run now.

type Card = {
  id: number;
  orderId: number;
  merchant: string;
  brand: string;
  value: number;
  last4: string | null;
  ccReservationId: number | null;
  orderDate: string | null;
  waitlistTargetRate: number | null;
  waitlistMaxDate: string | null;
  waitlistStatus: string | null;
  onWaitlist: boolean;
  currentRate: number | null;
  availableCap: number | null;
  decision: 'SUBMIT' | 'WAIT' | 'EXPIRE' | null;
};

type Payload = {
  today: string;
  autoEnabled: boolean;
  ratesError: string | null;
  reviewCount: number;
  cards: Card[];
};

type RunResult = {
  today: string;
  dryRun: boolean;
  submitted: number[];
  waiting: number[];
  expired: number[];
  errors: Array<{ id: number; message: string }>;
};

type BatchPlan = {
  groups: Array<{ buyOrderId: number; orderId: number; brand: string; value: number; rate: number; cardIds: number[]; face: number; payout: number }>;
  skipped: Array<{ id: number; reason: string }>;
  count: number; face: number; payout: number; brands: string[];
};
type BatchResult = {
  plan: BatchPlan;
  results: Array<{ id: number; status: 'submitted' | 'failed' | 'skipped'; reason?: string }>;
  submitted: number; failed: number; skipped: number;
};

const money = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
const pct = (n: number | null) => (n == null ? '—' : `${(n * 100).toFixed(2)}%`);
const shortDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—';

function plusDays(stamp: string, days: number): string {
  const d = new Date(`${stamp}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function DecisionBadge({ decision }: { decision: Card['decision'] }) {
  if (!decision) return null;
  const cls = {
    SUBMIT: 'bg-green-900/60 text-green-400',
    WAIT: 'bg-gray-800 text-gray-400',
    EXPIRE: 'bg-red-900/60 text-red-400',
  }[decision];
  const label = { SUBMIT: 'sells next run', WAIT: 'waiting', EXPIRE: 'past deadline' }[decision];
  return <span className={`text-xs px-1.5 py-0.5 rounded ${cls}`}>{label}</span>;
}

function Check({ checked, indeterminate, onChange, label }: {
  checked: boolean; indeterminate?: boolean; onChange: (v: boolean) => void; label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = !!indeterminate && !checked; }, [indeterminate, checked]);
  return (
    <input ref={ref} type="checkbox" aria-label={label} checked={checked}
      onChange={e => onChange(e.target.checked)}
      onClick={e => e.stopPropagation()}
      className="h-4 w-4 accent-blue-500 cursor-pointer" />
  );
}

function BrandSection({ group, open, onToggle, selected, setSelected }: {
  group: BrandGroup<Card>;
  open: boolean;
  onToggle: () => void;
  selected: Set<number>;
  setSelected: (ids: number[], on: boolean) => void;
}) {
  const ids = group.cards.map(c => c.id);
  const nSel = ids.filter(id => selected.has(id)).length;
  const onList = group.cards.filter(c => c.onWaitlist).length;
  const reserved = group.cards.filter(c => c.ccReservationId != null).length;
  const byValue = new Map<number, number[]>();
  for (const c of group.cards) byValue.set(c.value, [...(byValue.get(c.value) ?? []), c.id]);

  return (
    <div className="border border-gray-800 rounded">
      <div
        role="button" tabIndex={0} aria-expanded={open}
        onClick={onToggle}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-gray-900/50 select-none"
      >
        <Check label={`Select all ${group.brand}`} checked={nSel === ids.length}
          indeterminate={nSel > 0} onChange={v => setSelected(ids, v)} />
        <span className={`text-gray-500 text-xs transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
        <div className="flex-1 min-w-0">
          <div className="text-white">{group.brand}</div>
          <div className="text-xs text-gray-500">
            {group.count} card{group.count === 1 ? '' : 's'} · {money(group.face)} face
            {onList > 0 && <> · {onList} on waitlist</>}
            {reserved > 0 && <> · {reserved} reserved</>}
            {nSel > 0 && <span className="text-blue-400"> · {nSel} selected</span>}
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-white text-sm">{pct(group.bestRate)}</div>
          <div className="text-xs text-gray-500">
            {group.bestRate == null ? 'no live rate' : `${money(group.payoutNow)} now`}
          </div>
        </div>
      </div>

      {open && (
        <div className="border-t border-gray-800 overflow-x-auto">
          {byValue.size > 1 && (
            <div className="flex gap-3 flex-wrap px-4 py-2 text-xs text-gray-500">
              {[...byValue.entries()].map(([v, vids]) => {
                const all = vids.every(id => selected.has(id));
                return (
                  <button key={v} onClick={() => setSelected(vids, !all)} className="hover:text-gray-300">
                    {all ? 'Unselect' : 'Select'} all {money(v)} ({vids.length})
                  </button>
                );
              })}
            </div>
          )}
          <table className="w-full text-sm">
            <thead className="bg-gray-900 text-gray-500 uppercase text-xs">
              <tr>
                <th className="w-10 px-4 py-2" />
                <th className="px-2 py-2 text-left">Card</th>
                <th className="px-2 py-2 text-left">Order</th>
                <th className="px-2 py-2 text-right">Rate now</th>
                <th className="px-2 py-2 text-right">Payout now</th>
                <th className="px-2 py-2 text-left">Waitlist</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {group.cards.map(c => (
                <tr key={c.id} className={selected.has(c.id) ? 'bg-blue-950/30' : 'hover:bg-gray-900/40'}>
                  <td className="px-4 py-2">
                    <Check label={`Select ${money(c.value)} card ending ${c.last4 ?? ''}`}
                      checked={selected.has(c.id)} onChange={v => setSelected([c.id], v)} />
                  </td>
                  <td className="px-2 py-2 whitespace-nowrap">
                    <span className="text-green-400">{money(c.value)}</span>
                    {c.last4 && <span className="ml-2 font-mono text-xs text-gray-500">•• {c.last4}</span>}
                    {c.merchant !== c.brand && <span className="ml-2 text-xs text-gray-600">({c.merchant})</span>}
                  </td>
                  <td className="px-2 py-2 whitespace-nowrap text-xs">
                    <Link href={`/orders/${c.orderId}`} className="text-gray-400 hover:text-blue-400">
                      #{c.orderId}
                    </Link>
                    <span className="text-gray-600"> · {shortDate(c.orderDate)}</span>
                  </td>
                  <td className="px-2 py-2 text-right font-mono text-white">{pct(c.currentRate)}</td>
                  <td className="px-2 py-2 text-right font-mono text-gray-300">
                    {c.currentRate == null ? '—' : money(c.value * c.currentRate)}
                  </td>
                  <td className="px-2 py-2 whitespace-nowrap">
                    {c.ccReservationId != null ? (
                      <span className="text-xs text-yellow-500">reserved #{c.ccReservationId}</span>
                    ) : c.onWaitlist ? (
                      <span className="flex items-center gap-2">
                        <span className="font-mono text-white text-xs">{pct(c.waitlistTargetRate)}</span>
                        <span className="text-xs text-gray-500">by {c.waitlistMaxDate}</span>
                        <DecisionBadge decision={c.decision} />
                      </span>
                    ) : (
                      <span className="text-xs text-gray-600">
                        {c.waitlistStatus === 'EXPIRED' ? 'expired' : 'not listed'}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SubmitPanel({ cards, onDone }: { cards: Card[]; onDone: () => void }) {
  const [plan, setPlan] = useState<BatchPlan | null>(null);
  const [result, setResult] = useState<BatchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ids = cards.map(c => c.id);

  async function call(dryRun: boolean) {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/cardcenter/batch-submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardIds: ids, dryRun }),
      });
      const d = await res.json() as { error?: string; plan?: BatchPlan } & Partial<BatchResult>;
      if (!res.ok || d.error || !d.plan) { setError(d.error ?? 'Failed'); return; }
      if (dryRun) setPlan(d.plan); else { setPlan(null); setResult(d as BatchResult); }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <div className="text-xs border border-gray-800 rounded p-3 space-y-1 bg-gray-950">
        <div className="text-gray-300">
          {result.submitted} submitted, {result.failed} failed, {result.skipped} skipped
        </div>
        {result.results.map(r => (
          <div key={r.id} className={r.status === 'submitted' ? 'text-green-400' : r.status === 'failed' ? 'text-red-400' : 'text-yellow-500'}>
            card {r.id}: {r.status}{r.reason ? `, ${r.reason}` : ''}
          </div>
        ))}
        <button onClick={onDone} className="text-gray-400 hover:text-gray-200 pt-1">Close</button>
      </div>
    );
  }

  if (plan) {
    return (
      <div className="text-xs border border-yellow-800 rounded p-3 space-y-2 bg-gray-950">
        <div className="text-white text-sm">
          Sell {plan.count} card{plan.count === 1 ? '' : 's'} to CardCenter: {money(plan.face)} face, about {money(plan.payout)} payout
        </div>
        <div className="text-gray-400">Brands: {plan.brands.join(', ') || 'none'}</div>
        {plan.groups.map(g => (
          <div key={`${g.buyOrderId}-${g.orderId}`} className="text-gray-400">
            {g.brand} {money(g.value)} x {g.cardIds.length} at {pct(g.rate)} = {money(g.payout)}
          </div>
        ))}
        {plan.skipped.length > 0 && (
          <div className="text-yellow-500">{plan.skipped.length} will be skipped (already sold, needs review, or no live rate).</div>
        )}
        <div className="text-gray-500">Selling is irreversible. Rates are re-read when you confirm.</div>
        <div className="flex gap-2">
          <button onClick={() => void call(false)} disabled={busy || plan.count === 0}
            className="bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white px-3 py-1 rounded">
            {busy ? 'Submitting…' : `Confirm and sell ${plan.count}`}
          </button>
          <button onClick={() => setPlan(null)} disabled={busy} className="text-gray-400 hover:text-gray-200 px-2">Cancel</button>
        </div>
        {error && <div className="text-red-400">{error}</div>}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button onClick={() => void call(true)} disabled={busy}
        className="text-sm bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white px-4 py-1.5 rounded transition-colors">
        {busy ? 'Checking…' : 'Submit selected'}
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}

function BulkBar({ cards, today, onDone, onClear, onSold }: {
  cards: Card[];
  today: string;
  onDone: (msg: string) => void;
  onClear: () => void;
  onSold: () => void;
}) {
  const [target, setTarget] = useState('');
  const [maxDate, setMaxDate] = useState(plusDays(today, 30));
  const [cap, setCap] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const rate = Number(target) / 100;
  const rateOk = target.trim() !== '' && Number.isFinite(rate) && rate > 0 && rate <= 1;
  const capNum = cap.trim() === '' ? null : Number(cap);
  const capOk = capNum == null || (Number.isFinite(capNum) && capNum > 0);
  // Reserved cards are mid-sale on CardCenter; the waitlist leaves them alone.
  const eligible = cards.filter(c => c.ccReservationId == null);
  const pick = rateOk && capOk ? pickUnderPayout(eligible, rate, capNum) : null;
  const face = cards.reduce((a, c) => a + c.value, 0);

  async function send(body: Record<string, unknown>) {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/cardcenter/waitlist', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await res.json() as { error?: string; updated?: number; skipped?: number };
      if (!res.ok || d.error) { setError(d.error ?? 'Failed'); return; }
      onDone(`${d.updated} card${d.updated === 1 ? '' : 's'} updated${d.skipped ? `, ${d.skipped} skipped` : ''}.`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const apply = () => {
    if (!rateOk) { setError('Rate must be a percent between 0 and 100'); return; }
    if (!capOk) { setError('Max payout must be a dollar amount above 0, or blank'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(maxDate)) { setError('Pick a deadline'); return; }
    if (!pick || pick.take.length === 0) { setError('No selected card fits under that max payout'); return; }
    void send({ cardIds: pick.take, targetRate: rate, maxDate });
  };

  return (
    <div className="sticky bottom-0 z-10 border border-blue-900 bg-gray-950/95 backdrop-blur rounded p-3 space-y-2 shadow-lg">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-sm text-white">
          {cards.length} selected <span className="text-gray-500">· {money(face)} face</span>
        </div>
        <button onClick={onClear} className="text-xs text-gray-500 hover:text-gray-300">Clear selection</button>
      </div>
      <div className="flex items-end gap-3 flex-wrap">
        <label className="flex flex-col gap-1 text-xs text-gray-400">
          Sell at or above
          <span className="flex items-center gap-1">
            <input value={target} onChange={e => setTarget(e.target.value)} inputMode="decimal" placeholder="85"
              className="w-20 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-blue-500" />
            <span className="text-gray-500">%</span>
          </span>
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-400">
          Max payout (optional)
          <span className="flex items-center gap-1">
            <span className="text-gray-500">$</span>
            <input value={cap} onChange={e => setCap(e.target.value)} inputMode="decimal" placeholder="no cap"
              className="w-24 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-blue-500" />
          </span>
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-400">
          Deadline
          <input type="date" value={maxDate} min={today} onChange={e => setMaxDate(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-blue-500" />
        </label>
        <button onClick={apply} disabled={busy}
          className="text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-4 py-1.5 rounded transition-colors">
          {busy ? 'Saving…' : 'Add to waitlist'}
        </button>
        <button onClick={() => void send({ cardIds: cards.map(c => c.id), targetRate: null, maxDate: null })} disabled={busy}
          className="text-sm text-red-400 hover:text-red-300 disabled:opacity-50 px-2 py-1.5">
          Remove from waitlist
        </button>
      </div>
      {pick && (
        <div className="text-xs text-gray-400">
          Waitlists {pick.take.length} card{pick.take.length === 1 ? '' : 's'}, about {money(pick.payout)} at {target}%
          {pick.left.length > 0 && <span className="text-yellow-500"> · {pick.left.length} left off to stay under {money(capNum ?? 0)} (oldest cards go first)</span>}
          {eligible.length < cards.length && <span className="text-gray-500"> · {cards.length - eligible.length} reserved card{cards.length - eligible.length === 1 ? '' : 's'} skipped</span>}
        </div>
      )}
      {error && <div className="text-xs text-red-400">{error}</div>}
      <SubmitPanel key={cards.map(c => c.id).join(',')} cards={cards} onDone={onSold} />
    </div>
  );
}

export default function PendingPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [result, setResult] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [selected, setSelectedSet] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/cardcenter/waitlist');
      const d = await res.json() as Payload & { error?: string };
      if (!res.ok || d.error) { setError(d.error ?? 'Failed to load'); return; }
      setData(d);
      setError('');
      // Drop selections for cards that sold or disappeared since.
      const live = new Set(d.cards.map(c => c.id));
      setSelectedSet(prev => new Set([...prev].filter(id => live.has(id))));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const groups = useMemo(() => groupByBrand(data?.cards ?? []), [data]);
  const cardsById = useMemo(() => new Map((data?.cards ?? []).map(c => [c.id, c])), [data]);
  const selectedCards = [...selected].map(id => cardsById.get(id)).filter((c): c is Card => !!c);

  const setSelected = (ids: number[], on: boolean) => setSelectedSet(prev => {
    const next = new Set(prev);
    for (const id of ids) { if (on) next.add(id); else next.delete(id); }
    return next;
  });
  const toggleOpen = (brand: string) => setOpen(prev => {
    const next = new Set(prev);
    if (next.has(brand)) next.delete(brand); else next.add(brand);
    return next;
  });

  async function run(dryRun: boolean) {
    setRunning(true);
    setResult(null);
    try {
      const res = await fetch('/api/cardcenter/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun }),
      });
      const d = await res.json() as RunResult & { error?: string };
      if (!res.ok || d.error) { setError(d.error ?? 'Run failed'); return; }
      setResult(d);
      if (!dryRun) await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  }

  async function toggleAuto(next: boolean) {
    await fetch('/api/cardcenter/waitlist', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoEnabled: next }),
    });
    await load();
  }

  if (loading) return <div className="text-gray-500 text-sm">Loading…</div>;

  const cards = data?.cards ?? [];
  const face = cards.reduce((a, c) => a + c.value, 0);
  const onList = cards.filter(c => c.onWaitlist).length;
  const allOpen = groups.length > 0 && groups.every(g => open.has(g.brand));

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-lg text-white">Pending</h1>
          <p className="text-xs text-gray-500">
            {cards.length} unsold card{cards.length === 1 ? '' : 's'} · {money(face)} face · {groups.length} brand{groups.length === 1 ? '' : 's'}
            {' '}· {onList} on the waitlist. A waitlisted card sells once CardCenter pays at least its rate.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <label className="flex items-center gap-2 text-xs text-gray-400">
            <input type="checkbox" checked={data?.autoEnabled ?? false}
              onChange={e => void toggleAuto(e.target.checked)} />
            Run automatically (hourly)
          </label>
          <button onClick={() => void run(true)} disabled={running}
            className="text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 px-3 py-1 rounded transition-colors disabled:opacity-50">
            Preview
          </button>
          <button onClick={() => void run(false)} disabled={running}
            className="text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-3 py-1 rounded transition-colors">
            {running ? 'Running…' : 'Run now'}
          </button>
        </div>
      </div>

      {error && <div className="text-sm text-red-400">{error}</div>}
      {notice && <div className="text-xs text-green-400">{notice}</div>}
      {data?.ratesError && (
        <div className="text-xs text-yellow-500">
          Live rates unavailable, so rates and payouts are blank until CardCenter answers. ({data.ratesError})
        </div>
      )}
      {data && data.reviewCount > 0 && (
        <div className="text-xs text-yellow-500">
          {data.reviewCount} more card{data.reviewCount === 1 ? '' : 's'} need a brand and value before they can be listed (eGift review).
        </div>
      )}

      {result && (
        <div className="text-xs text-gray-400 border border-gray-800 rounded p-3 space-y-1">
          <div className="text-gray-300">
            {result.dryRun ? 'Preview' : 'Run'} for {result.today}: {result.submitted.length} {result.dryRun ? 'would sell' : 'submitted'},
            {' '}{result.waiting.length} waiting, {result.expired.length} past deadline
          </div>
          {result.errors.map((e, i) => (
            <div key={i} className="text-red-400">card {e.id}: {e.message}</div>
          ))}
        </div>
      )}

      {groups.length > 0 && (
        <div className="flex justify-end">
          <button className="text-xs text-gray-500 hover:text-gray-300"
            onClick={() => setOpen(allOpen ? new Set() : new Set(groups.map(g => g.brand)))}>
            {allOpen ? 'Collapse all' : 'Expand all'}
          </button>
        </div>
      )}

      <div className="space-y-2">
        {groups.map(g => (
          <BrandSection key={g.brand} group={g} open={open.has(g.brand)} onToggle={() => toggleOpen(g.brand)}
            selected={selected} setSelected={setSelected} />
        ))}
        {groups.length === 0 && (
          <div className="border border-gray-800 rounded px-4 py-6 text-center text-gray-600 text-sm">
            No unsold gift cards.
          </div>
        )}
      </div>

      {selectedCards.length > 0 && data && (
        <BulkBar
          cards={selectedCards}
          today={data.today}
          onClear={() => setSelectedSet(new Set())}
          onSold={() => { setSelectedSet(new Set()); void load(); }}
          onDone={msg => { setNotice(msg); setSelectedSet(new Set()); void load(); }}
        />
      )}
    </div>
  );
}
