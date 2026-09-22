'use client';

import { useCallback, useEffect, useState } from 'react';

// CardCenter waitlist. Park an unsold gift card with a target sell rate and a
// deadline; the runner submits it as soon as CardCenter pays at least that rate
// for that brand and denomination, or marks it expired when the deadline passes.

type Card = {
  id: number;
  orderId: number;
  merchant: string;
  value: number;
  waitlistTargetRate: number | null;
  waitlistMaxDate: string | null;
  waitlistStatus: string | null;
  onWaitlist: boolean;
  currentRate: number | null;
  buyOrderId: number | null;
  availableCap: number | null;
  decision: 'SUBMIT' | 'WAIT' | 'EXPIRE' | null;
};

type Payload = {
  today: string;
  autoEnabled: boolean;
  ratesError: string | null;
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

const money = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

const pct = (n: number | null) => (n == null ? '—' : `${(n * 100).toFixed(2)}%`);

function DecisionBadge({ decision }: { decision: Card['decision'] }) {
  if (!decision) return <span className="text-gray-600">—</span>;
  const cls = {
    SUBMIT: 'bg-green-900/60 text-green-400',
    WAIT: 'bg-gray-800 text-gray-400',
    EXPIRE: 'bg-red-900/60 text-red-400',
  }[decision];
  return <span className={`text-xs px-1.5 py-0.5 rounded ${cls}`}>{decision}</span>;
}

function CardRow({ card, today, onSaved }: {
  card: Card;
  today: string;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  // Shown as a percent because that is how the Rates page reads; stored as the
  // fraction the API and CardCenter both use.
  const [target, setTarget] = useState(
    card.waitlistTargetRate != null ? (card.waitlistTargetRate * 100).toFixed(2) : '',
  );
  const [maxDate, setMaxDate] = useState(card.waitlistMaxDate ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/cardcenter/waitlist', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardId: card.id, ...body }),
      });
      const d = await res.json() as { error?: string };
      if (!res.ok || d.error) { setError(d.error ?? 'Failed'); return; }
      setEditing(false);
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const save = () => {
    const rate = Number(target) / 100;
    if (!Number.isFinite(rate) || rate <= 0 || rate > 1) {
      setError('Target must be a percent between 0 and 100');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(maxDate)) {
      setError('Pick a deadline date');
      return;
    }
    void patch({ targetRate: rate, maxDate });
  };

  return (
    <tr className="hover:bg-gray-900/40 align-top">
      <td className="px-4 py-2.5 text-white">
        {card.merchant}
        <span className="text-gray-500"> · </span>
        <span className="text-green-400">{money(card.value)}</span>
        <div className="text-xs text-gray-600">order #{card.orderId}</div>
      </td>
      <td className="px-4 py-2.5 text-right font-mono text-white">{pct(card.currentRate)}</td>
      <td className="px-4 py-2.5">
        {editing ? (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1">
              <input
                value={target}
                onChange={e => setTarget(e.target.value)}
                placeholder="85"
                className="w-16 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
              />
              <span className="text-xs text-gray-500">%</span>
              <input
                type="date"
                value={maxDate}
                min={today}
                onChange={e => setMaxDate(e.target.value)}
                className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
              />
            </div>
            <div className="flex items-center gap-2">
              <button onClick={save} disabled={busy}
                className="text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-3 py-1 rounded transition-colors">
                {busy ? 'Saving…' : 'Save'}
              </button>
              <button onClick={() => setEditing(false)}
                className="text-xs text-gray-500 hover:text-gray-300 transition-colors">Cancel</button>
              {card.onWaitlist && (
                <button onClick={() => void patch({ targetRate: null, maxDate: null })} disabled={busy}
                  className="text-xs text-red-400 hover:text-red-300 transition-colors">Remove</button>
              )}
            </div>
            {error && <span className="text-xs text-red-400">{error}</span>}
          </div>
        ) : card.onWaitlist ? (
          <button onClick={() => setEditing(true)} className="text-left group">
            <span className="font-mono text-white">{pct(card.waitlistTargetRate)}</span>
            <span className="text-gray-500"> by </span>
            <span className="text-gray-300">{card.waitlistMaxDate}</span>
            <span className="ml-2 text-xs text-gray-600 group-hover:text-blue-400">edit</span>
          </button>
        ) : (
          <button onClick={() => setEditing(true)}
            className="text-xs bg-gray-800 hover:bg-blue-700 border border-gray-700 hover:border-blue-600 text-gray-300 hover:text-white px-3 py-1 rounded transition-colors">
            Add to waitlist
          </button>
        )}
      </td>
      <td className="px-4 py-2.5"><DecisionBadge decision={card.decision} /></td>
      <td className="hidden sm:table-cell px-4 py-2.5 text-xs text-gray-500">
        {card.waitlistStatus ?? '—'}
      </td>
    </tr>
  );
}

export default function WaitlistPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [result, setResult] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/cardcenter/waitlist');
      const d = await res.json() as Payload & { error?: string };
      if (!res.ok || d.error) { setError(d.error ?? 'Failed to load'); return; }
      setData(d);
      setError('');
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

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
  const onList = cards.filter(c => c.onWaitlist);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-lg text-white">Waitlist</h1>
          <p className="text-xs text-gray-500">
            {onList.length} of {cards.length} unsold card{cards.length === 1 ? '' : 's'} on the
            waitlist. A card sells as soon as CardCenter pays at least its target rate.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-gray-400">
            <input
              type="checkbox"
              checked={data?.autoEnabled ?? false}
              onChange={e => void toggleAuto(e.target.checked)}
            />
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
      {data?.ratesError && (
        <div className="text-xs text-yellow-500">
          Live rates unavailable — decisions are hidden until CardCenter answers. ({data.ratesError})
        </div>
      )}

      {result && (
        <div className="text-xs text-gray-400 border border-gray-800 rounded p-3 space-y-1">
          <div className="text-gray-300">
            {result.dryRun ? 'Preview' : 'Run'} for {result.today}: {result.submitted.length} submitted,
            {' '}{result.waiting.length} waiting, {result.expired.length} expired
          </div>
          {result.errors.map((e, i) => (
            <div key={i} className="text-red-400">card {e.id}: {e.message}</div>
          ))}
        </div>
      )}

      <div className="border border-gray-800 rounded overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-900 text-gray-500 uppercase text-xs">
            <tr>
              <th className="px-4 py-2 text-left">Card</th>
              <th className="px-4 py-2 text-right">Current rate</th>
              <th className="px-4 py-2 text-left">Target / deadline</th>
              <th className="px-4 py-2 text-left">Today</th>
              <th className="hidden sm:table-cell px-4 py-2 text-left">Last run</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {cards.map(c => (
              <CardRow key={c.id} card={c} today={data?.today ?? ''} onSaved={() => void load()} />
            ))}
            {cards.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-600 text-sm">
                No unsold gift cards.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
