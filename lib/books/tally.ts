// Darkbloom monthly tally consumer. Reads the read-only bloom-ledger endpoint
// (env BLOOM_LEDGER_URL; disabled when unset). Final months at or after go-live
// are posted as one `darkbloom:<month>` entry; a changed hash re-posts.
import type { BooksStore, LineInput } from './types.ts';
import { type DesiredEntry } from './desired.ts';
import { applyDesired, type ReconcileResult } from './reconcile.ts';
import { accountForCategory } from './chart.ts';
import { lastDayOfMonth, monthOf, MONTH_RE } from './dates.ts';

export type TallyEntry = {
  id?: number | string; kind?: string; date?: string; category?: string | null; vendor?: string | null; purpose?: string | null;
  business_pct?: number | null; amount_cents?: number | null; deductible_cents?: number | null; effect?: string | null;
};
export type TallyMachine = {
  machine_id: string | null; shared?: boolean;
  earnings_cents?: number | null; other_income_cents?: number | null; power_cost_cents?: number | null;
  depreciation_cents?: number | null; lease_cents?: number | null; entries_deductible_cents?: number | null;
  entries?: TallyEntry[];
};
export type TallyMonth = {
  month: string; timezone?: string; final: boolean; hash: string;
  totals?: unknown;
  balances?: { as_of?: string; available_cents?: number | null; withdrawable_cents?: number | null } | null;
  machines: TallyMachine[];
};
export type TallyIndex = { generated_at?: string; months: { month: string; final: boolean; hash: string }[] };

const n = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0);

const COLUMNS = ['earnings_cents', 'other_income_cents', 'power_cost_cents', 'depreciation_cents', 'lease_cents'] as const;

/** Columns the ledger did not compute (null): they post nothing and the UI lists them as "not computed". */
export function tallyNotComputed(t: TallyMonth): { machine: string | null; column: string }[] {
  const out: { machine: string | null; column: string }[] = [];
  for (const m of t.machines) for (const c of COLUMNS) if (m[c] == null) out.push({ machine: m.shared ? null : m.machine_id, column: c });
  return out;
}

/** Journal entry a tally month should produce. Null columns post nothing. */
export function desiredTallyEntry(t: TallyMonth): DesiredEntry[] {
  const lines: LineInput[] = [];
  const add = (account: string, amountCents: number, machine: string | null, memo?: string | null) => {
    if (amountCents) lines.push({ account, amountCents, machineId: machine, business: 'darkbloom', memo: memo ?? null });
  };
  for (const m of t.machines) {
    const mid = m.shared ? null : m.machine_id;
    const earn = n(m.earnings_cents);
    add('darkbloom_balance', earn, mid, 'Earnings');
    add('darkbloom_earnings', -earn, mid);
    const other = n(m.other_income_cents);
    add('darkbloom_balance', other, mid, 'Other income');
    add('other_income', -other, mid);
    const power = n(m.power_cost_cents);
    add('exp_utilities', power, mid, 'Metered power');
    add('due_to_owner', -power, mid);
    const dep = n(m.depreciation_cents);
    add('exp_depreciation', dep, mid);
    add('accum_depreciation', -dep, mid);
    const lease = n(m.lease_cents);
    add('exp_equipment_lease', lease, mid);
    add('due_to_owner', -lease, mid);
    // Only expense entries with a deductible amount post (Dr expense / Cr Due to owner). Income is already in
    // other_income_cents, metered_power in power_cost_cents; capitalized items post as equipment (Dr darkbloom_equipment / Cr due_to_owner) and are expensed through depreciation.
    for (const e of m.entries ?? []) {
      if (e.effect === 'capitalized') {
        // Hardware is depreciated, not expensed: put its (business-share) cost on the books as equipment, owed to the owner.
        const pct = typeof e.business_pct === 'number' ? e.business_pct : 100;
        const cost = Math.round((n(e.amount_cents) * pct) / 100);
        if (cost > 0) {
          add('darkbloom_equipment', cost, mid, e.purpose ?? e.vendor ?? 'Equipment');
          add('due_to_owner', -cost, mid);
        }
        continue;
      }
      if (e.effect !== 'expense') continue;
      const ded = n(e.deductible_cents);
      if (ded <= 0) continue;
      add(accountForCategory(e.category ?? 'other'), ded, mid, e.purpose ?? e.vendor ?? null);
      add('due_to_owner', -ded, mid);
    }
  }
  if (lines.length === 0) return [];
  return [{
    sourceKey: `darkbloom:${t.month}`, date: lastDayOfMonth(t.month), source: 'darkbloom',
    memo: `Darkbloom tally ${t.month}`, lines,
  }];
}

export type TallyRow = { month: string; hash: string; postedEntryId: number | null };
export interface TallyRows {
  get(userId: number, month: string): Promise<TallyRow | null>;
  save(userId: number, row: TallyRow & { payload: string }): Promise<void>;
}

export type TallySyncResult = ReconcileResult & { checked: number; skippedNonFinal: number; unchanged: number };

export async function syncTally(
  store: BooksStore,
  rows: TallyRows,
  userId: number,
  opts: { baseUrl: string | undefined; goLive: string; now: Date; fetchFn?: typeof fetch },
): Promise<TallySyncResult | { disabled: true }> {
  if (!opts.baseUrl) return { disabled: true };
  const f = opts.fetchFn ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, '');
  const out: TallySyncResult = { posted: 0, reversed: 0, errors: [], checked: 0, skippedNonFinal: 0, unchanged: 0 };
  const idx = (await (await f(`${base}/v1/tally/months`)).json()) as TallyIndex;
  const goMonth = monthOf(opts.goLive);
  for (const m of idx.months ?? []) {
    if (!MONTH_RE.test(m.month) || m.month < goMonth) continue;
    if (!m.final) { out.skippedNonFinal++; continue; }
    out.checked++;
    try {
      const have = await rows.get(userId, m.month);
      const live = await store.livePosted(userId, `darkbloom:${m.month}`);
      if (have && have.hash === m.hash && (live.length > 0 || have.postedEntryId == null)) { out.unchanged++; continue; }
      const res = await f(`${base}/v1/tally/monthly?month=${encodeURIComponent(m.month)}`);
      const payload = (await res.json()) as TallyMonth;
      if (!payload.final) { out.skippedNonFinal++; continue; }
      const r = await applyDesired(store, userId, desiredTallyEntry(payload), { prefix: `darkbloom:${m.month}`, only: [`darkbloom:${m.month}`] }, opts.now);
      out.posted += r.posted; out.reversed += r.reversed; out.errors.push(...r.errors);
      if (r.errors.length) continue;
      const after = await store.livePosted(userId, `darkbloom:${m.month}`);
      await rows.save(userId, { month: m.month, hash: payload.hash ?? m.hash, postedEntryId: after[0]?.id ?? null, payload: JSON.stringify(payload) });
    } catch (e) {
      out.errors.push(`${m.month}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}
