import { looksLikeAddress } from './orderFieldSync.ts';
import { isUselessDescription } from './gapFill.ts';

// Targeted Amazon page visits. An Amazon ORDER or SHIPPED email says which
// order needs a look; this decides what (pure, no database), keeps the
// pending list, and applies the limits that make browsing small and slow.
// lib/amazonVisitQueue.ts stores the state and hands visits to the extension.
//
// Two ways a visit happens, both for pages the person's own browser loads
// (real tab navigation, read passively):
//  - automatic: a minimized-window run the extension starts on its poll, for
//    orders whose email arrived some minutes ago;
//  - clicked: "Sync Amazon" works the same pending list, plus a once-a-day
//    read of order-list page 1 to catch an order whose email never came.

export type Stage = 'detail' | 'track';

// --- limits (named in the PR) -------------------------------------------------
/** An automatic visit waits a random 5 to 25 minutes after its email. */
export const EMAIL_DELAY_MIN_MS = 5 * 60_000;
export const EMAIL_DELAY_MAX_MS = 25 * 60_000;
/** Orders in one automatic run. */
export const AUTO_MAX_ORDERS_PER_RUN = 3;
/** Page loads (detail + Track package) the automatic runs may use per day. */
export const AUTO_DAILY_PAGE_LOADS = 12;
/** Orders in one clicked run. */
export const CLICK_MAX_ORDERS = 10;
/** An order visited this recently that is still unfinished is skipped. */
export const RECENT_VISIT_MS = 6 * 3_600_000;
/** The order-list page 1 safety net runs at most this often. */
export const LIST_READ_EVERY_MS = 24 * 3_600_000;
/** Finished entries are forgotten after this long. */
export const KEEP_ENTRY_MS = 60 * 86_400_000;
export const MAX_ENTRIES = 500;

// --- what an email's order needs ---------------------------------------------

export type VisitRow = {
  cardId: number | null;
  shippingAddress: string | null;
  cost: number;
  itemDescription: string | null;
  trackingNumbers: string | null;
  cancelled: boolean;
  /** Delivered already (a delivered email was imported). */
  delivered?: boolean;
};

export type VisitDecision = { stages: Stage[]; reasons: string[] };

/**
 * Local-model hook (NOT wired up; nothing calls a model). A later version can
 * pass a judge that sees the same facts and may narrow or widen the stages,
 * for example to skip an order whose item the email already named well. It
 * must return null to keep the rule-based answer.
 */
export type VisitJudge = (ctx: { kind: string; row: VisitRow; rule: VisitDecision }) => VisitDecision | null;

/**
 * What page kinds can fill what the tracker row still lacks.
 *  - Card, address, cost or item missing: the detail page has them.
 *  - Shipped with no tracking number: the detail page, then its Track package page.
 *  - Delivered and cancelled emails, cancelled or delivered orders, and
 *    orders that lack nothing: no visit.
 */
export function planAmazonVisit(kind: string, row: VisitRow, judge?: VisitJudge): VisitDecision {
  const none: VisitDecision = { stages: [], reasons: [] };
  if (kind !== 'ordered' && kind !== 'shipped') return none;
  if (row.cancelled) return none;
  const reasons: string[] = [];
  if (row.cardId == null) reasons.push('card');
  if (!looksLikeAddress(row.shippingAddress ?? '')) reasons.push('address');
  if (!(row.cost > 0)) reasons.push('cost');
  if (isUselessDescription(row.itemDescription)) reasons.push('item');
  const needsTracking = kind === 'shipped' && !row.delivered && !String(row.trackingNumbers ?? '').trim();
  if (needsTracking) reasons.push('tracking');
  const stages: Stage[] = needsTracking ? ['detail', 'track'] : reasons.length ? ['detail'] : [];
  const rule = { stages, reasons };
  return judge?.({ kind, row, rule }) ?? rule;
}

// --- pending list ------------------------------------------------------------

export type VisitEntry = {
  /** Full order number, 111-0000000-0000001. */
  order: string;
  /** A safe stored order link (lib/amazonOrderLink.ts); otherwise the extension builds the URL. */
  url?: string;
  /** Stages still to do. */
  stages: Stage[];
  /** Stages finished; never visited again. */
  done: Stage[];
  /** Stages the automatic runs already tried once. */
  autoTried: Stage[];
  queuedAt: string;
  /** Not before this (the random delay after the email). */
  dueAt: string;
  lastVisitAt?: string;
};

export type VisitState = {
  entries: VisitEntry[];
  listReadAt?: string;
  /** Set when an automatic run hit a sign-in, CAPTCHA or block page; cleared by a click on Sync. */
  pausedAt?: string;
  auto?: { day: string; pageLoads: number };
};

export const emptyState = (): VisitState => ({ entries: [] });

export function parseState(json: string | null | undefined): VisitState {
  try {
    const p = JSON.parse(json ?? '') as Partial<VisitState>;
    if (!p || !Array.isArray(p.entries)) return emptyState();
    return { ...p, entries: p.entries.filter(e => e && typeof e.order === 'string' && Array.isArray(e.stages)) } as VisitState;
  } catch { return emptyState(); }
}

const digits = (s: string) => String(s ?? '').replace(/\D/g, '');
const ORDER_NO = /^\d{3}-\d{7}-\d{7}$/;
const dayOf = (d: Date) => d.toISOString().slice(0, 10);

export function randomDelayMs(rnd: () => number = Math.random): number {
  return Math.round(EMAIL_DELAY_MIN_MS + rnd() * (EMAIL_DELAY_MAX_MS - EMAIL_DELAY_MIN_MS));
}

/** Adds visits from emails. A stage already finished or already pending is not added again. */
export function addVisits(
  state: VisitState,
  adds: readonly { order: string; url?: string | null; stages: readonly Stage[] }[],
  now: Date,
  rnd: () => number = Math.random,
): VisitState {
  const entries = state.entries.map(e => ({ ...e }));
  for (const a of adds) {
    if (!ORDER_NO.test(a.order) || !a.stages.length) continue;
    let e = entries.find(x => digits(x.order) === digits(a.order));
    if (!e) {
      e = { order: a.order, stages: [], done: [], autoTried: [], queuedAt: now.toISOString(), dueAt: new Date(now.getTime() + randomDelayMs(rnd)).toISOString() };
      entries.push(e);
    }
    const fresh = a.stages.filter(s => !e!.done.includes(s) && !e!.stages.includes(s));
    if (!fresh.length) continue;
    if (!e.stages.length) e.dueAt = new Date(now.getTime() + randomDelayMs(rnd)).toISOString();
    e.stages.push(...fresh);
    if (a.url && !e.url) e.url = a.url;
  }
  return { ...state, entries: prune(entries, now) };
}

function prune(entries: VisitEntry[], now: Date): VisitEntry[] {
  const keep = entries.filter(e => e.stages.length || now.getTime() - new Date(e.queuedAt).getTime() < KEEP_ENTRY_MS);
  return keep.length > MAX_ENTRIES ? keep.slice(keep.length - MAX_ENTRIES) : keep;
}

export type Visit = { orderNumber: string; url: string | null; stages: Stage[] };

const loads = (stages: readonly Stage[]) => (stages.includes('track') ? 2 : 1);
const recent = (e: VisitEntry, now: Date) => !!e.lastVisitAt && now.getTime() - new Date(e.lastVisitAt).getTime() < RECENT_VISIT_MS;

export function shuffle<T>(items: readonly T[], rnd: () => number = Math.random): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/**
 * The orders an automatic run may visit now: not paused, due, each stage once,
 * not visited in the last 6 hours, a few orders, within the day's page budget.
 */
export function pickAuto(state: VisitState, now: Date, rnd: () => number = Math.random): { visits: Visit[]; state: VisitState } {
  if (state.pausedAt) return { visits: [], state };
  const day = dayOf(now);
  let used = state.auto?.day === day ? state.auto.pageLoads : 0;
  const entries = state.entries.map(e => ({ ...e, autoTried: [...e.autoTried] }));
  const visits: Visit[] = [];
  const due = entries
    .filter(e => e.stages.some(s => !e.autoTried.includes(s)) && new Date(e.dueAt) <= now && !recent(e, now))
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  for (const e of due) {
    if (visits.length >= AUTO_MAX_ORDERS_PER_RUN) break;
    const stages = e.stages.filter(s => !e.autoTried.includes(s));
    if (used + loads(stages) > AUTO_DAILY_PAGE_LOADS) continue;
    used += loads(stages);
    e.autoTried.push(...stages);
    e.lastVisitAt = now.toISOString();
    visits.push({ orderNumber: e.order, url: e.url ?? null, stages });
  }
  return { visits: shuffle(visits, rnd), state: visits.length ? { ...state, entries, auto: { day, pageLoads: used } } : state };
}

/** The orders a clicked run visits: a random few of the pending ones, shuffled; recent visits skipped. */
export function pickClick(state: VisitState, now: Date, cap = CLICK_MAX_ORDERS, rnd: () => number = Math.random): { visits: Visit[]; state: VisitState } {
  const entries = state.entries.map(e => ({ ...e }));
  const pool = shuffle(entries.filter(e => e.stages.length && !recent(e, now)), rnd).slice(0, Math.max(0, cap));
  for (const e of pool) e.lastVisitAt = now.toISOString();
  return {
    visits: pool.map(e => ({ orderNumber: e.order, url: e.url ?? null, stages: [...e.stages] })),
    state: pool.length ? { ...state, entries } : state,
  };
}

/** A captured page finished this stage for this order. */
export function completeStage(state: VisitState, order: string, stages: readonly Stage[]): VisitState {
  if (!state.entries.some(e => digits(e.order) === digits(order) && e.stages.some(s => stages.includes(s)))) return state;
  return {
    ...state,
    entries: state.entries.map(e => {
      if (digits(e.order) !== digits(order)) return e;
      return { ...e, stages: e.stages.filter(s => !stages.includes(s)), done: [...new Set([...e.done, ...stages.filter(s => e.stages.includes(s))])] };
    }),
  };
}

export const needsListRead = (state: VisitState, now: Date) =>
  !state.listReadAt || now.getTime() - new Date(state.listReadAt).getTime() >= LIST_READ_EVERY_MS;
export const markListRead = (state: VisitState, now: Date): VisitState => ({ ...state, listReadAt: now.toISOString() });
export const pauseAuto = (state: VisitState, now: Date): VisitState => ({ ...state, pausedAt: now.toISOString() });
export const resumeAuto = (state: VisitState): VisitState => { const { pausedAt: _p, ...rest } = state; return rest; };
