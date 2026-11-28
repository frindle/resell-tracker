import { looksLikeAddress } from './orderFieldSync.ts';
import { isReplaceableDescription } from './gapFill.ts';
import { isItemSummary } from './itemSummary.ts';

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
//
// A visit only counts once the tracker has read the page. An automatic run
// whose pages were never read (the tab timed out, the browser was closed)
// puts its orders back in line after a short wait, and an order that was read
// but still has no tracking gets another look later. Both are bounded.

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
/** An order visited this recently that is still unfinished is skipped by the automatic runs. */
export const RECENT_VISIT_MS = 6 * 3_600_000;
/** Automatic runs one order may be in, in total. */
export const AUTO_MAX_RUNS = 6;
/** No automatic visit this long after the order's last email; a click on Sync still visits it. */
export const AUTO_GIVE_UP_MS = 7 * 86_400_000;
/** Wait after a run that read none of an order's pages: this times the failures in a row, for the first few. */
export const FAIL_BACKOFF_MS = 20 * 60_000;
export const FAIL_QUICK_RETRIES = 3;
/** After the quick retries, one try this often. */
export const FAIL_SLOW_RETRY_MS = 24 * 3_600_000;
/** A clicked run skips an order whose page was read this recently. */
export const CLICK_RECENT_READ_MS = 30 * 60_000;
/** The order-list page 1 safety net runs at most this often. */
export const LIST_READ_EVERY_MS = 24 * 3_600_000;
/** A click that has no order to visit reads the order list when the last read is older than this. */
export const LIST_READ_IDLE_CLICK_MS = 3_600_000;
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
  if (isReplaceableDescription(row.itemDescription) || isItemSummary(row.itemDescription)) reasons.push('item');
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
  /** Stages an automatic run was sent to at least once. */
  autoTried: Stage[];
  /** When its newest stage was queued. */
  queuedAt: string;
  /** Not before this (the random delay after the email, or the wait after a run that read nothing). */
  dueAt: string;
  /** When a run was last sent to it. */
  lastVisitAt?: string;
  /** When the tracker last read one of its pages. */
  lastReadAt?: string;
  /** Automatic runs it was in. */
  autoRuns?: number;
  /** Automatic runs in a row that read none of its pages. */
  fails?: number;
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
    e.stages = [...e.stages, ...fresh];
    // A new email starts the automatic tries over for this order.
    e.queuedAt = now.toISOString();
    e.autoRuns = 0;
    e.fails = 0;
    // An earlier read says nothing about what this email asks for.
    delete e.lastReadAt;
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
/** The page loads a run of these visits is charged when it is picked (a detail page, plus one Track package page). */
export function plannedLoads(visits: readonly { stages: readonly Stage[] }[]): number {
  return visits.reduce((n, v) => n + loads(v.stages), 0);
}
const recent = (e: VisitEntry, now: Date) => !!e.lastVisitAt && now.getTime() - new Date(e.lastVisitAt).getTime() < RECENT_VISIT_MS;

export function shuffle<T>(items: readonly T[], rnd: () => number = Math.random): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const ms = (iso: string | undefined) => (iso ? new Date(iso).getTime() : 0);
/** Automatic runs so far. Entries saved before the counter existed: one when every pending stage was already tried. */
const runsOf = (e: VisitEntry) => e.autoRuns ?? (e.stages.some(s => !e.autoTried.includes(s)) ? 0 : 1);

/** Whether automatic runs have stopped trying this order (too old, or too many runs). */
export function autoGaveUp(e: VisitEntry, now: Date): boolean {
  return now.getTime() - ms(e.queuedAt) > AUTO_GIVE_UP_MS || runsOf(e) >= AUTO_MAX_RUNS;
}

/** Whether an automatic run will look at this order again: false once its page was read and only details are left (see autoEligible). */
export const autoWillLook = (e: VisitEntry): boolean => e.stages.length > 0 && !(e.lastReadAt && !e.stages.includes('track'));

/** Earliest time an automatic run may visit this order: its due time, or 6 hours after the last visit if later. */
export const autoNextAt = (e: VisitEntry): string =>
  new Date(Math.max(ms(e.dueAt), e.lastVisitAt ? ms(e.lastVisitAt) + RECENT_VISIT_MS : 0)).toISOString();

/** Whether an automatic run may visit this order now. */
function autoEligible(e: VisitEntry, now: Date): boolean {
  if (!e.stages.length || new Date(e.dueAt) > now || recent(e, now)) return false;
  if (now.getTime() - ms(e.queuedAt) > AUTO_GIVE_UP_MS) return false;
  if (runsOf(e) >= AUTO_MAX_RUNS) return false;
  // Its page was read and only details are left (compare mode): another look changes nothing.
  // A missing tracking number can still turn up, so that keeps its later looks.
  if (e.lastReadAt && !e.stages.includes('track')) return false;
  return true;
}

/**
 * The orders an automatic run may visit now: not paused, due, not sent to in
 * the last 6 hours, a few orders, within the day's page budget. Orders never
 * tried go first. Every pending stage of an order is asked for each time.
 */
export function pickAuto(state: VisitState, now: Date, rnd: () => number = Math.random): { visits: Visit[]; state: VisitState } {
  if (state.pausedAt) return { visits: [], state };
  const day = dayOf(now);
  let used = state.auto?.day === day ? state.auto.pageLoads : 0;
  const entries = state.entries.map(e => ({ ...e, autoTried: [...e.autoTried] }));
  const visits: Visit[] = [];
  const due = entries
    .filter(e => autoEligible(e, now))
    .sort((a, b) => runsOf(a) - runsOf(b) || a.dueAt.localeCompare(b.dueAt));
  for (const e of due) {
    if (visits.length >= AUTO_MAX_ORDERS_PER_RUN) break;
    const stages = [...e.stages];
    if (used + loads(stages) > AUTO_DAILY_PAGE_LOADS) continue;
    used += loads(stages);
    e.autoRuns = runsOf(e) + 1;
    e.autoTried = [...new Set([...e.autoTried, ...stages])];
    e.lastVisitAt = now.toISOString();
    visits.push({ orderNumber: e.order, url: e.url ?? null, stages });
  }
  return { visits: shuffle(visits, rnd), state: visits.length ? { ...state, entries, auto: { day, pageLoads: used } } : state };
}

/** How long an order waits after a run that read none of its pages. */
export function failBackoffMs(fails: number): number {
  return fails <= FAIL_QUICK_RETRIES ? FAIL_BACKOFF_MS * Math.max(1, fails) : FAIL_SLOW_RETRY_MS;
}

/**
 * An automatic run has ended. An order it was sent to whose pages were not
 * read since the run was queued goes back in line: it waits a short while
 * (longer each time), then an automatic run may try it again. The page loads
 * stay counted against the day's budget.
 *
 * refund: the run never got to its orders for a reason that is not theirs
 * (another run was going, or a sign-in or block page stopped it). Those orders
 * get their try back and wait the shortest time.
 */
export function settleAutoRun(state: VisitState, orders: readonly string[], since: Date, now: Date, refund = false): VisitState {
  const sent = new Set(orders.map(digits));
  let changed = false;
  const entries = state.entries.map(e => {
    if (!e.stages.length || !sent.has(digits(e.order))) return e;
    if (ms(e.lastReadAt) >= since.getTime()) return e;
    changed = true;
    const fails = refund ? (e.fails ?? 0) : (e.fails ?? 0) + 1;
    const next: VisitEntry = { ...e, fails, dueAt: new Date(now.getTime() + (refund ? FAIL_BACKOFF_MS : failBackoffMs(fails))).toISOString() };
    if (refund) next.autoRuns = Math.max(0, runsOf(e) - 1);
    // The 6-hour spacing counts from the last page that was really read.
    if (e.lastReadAt) next.lastVisitAt = e.lastReadAt; else delete next.lastVisitAt;
    return next;
  });
  return changed ? { ...state, entries } : state;
}

/** A run opened more pages than it was charged for when picked: the rest comes off today's budget. */
export function chargeExtraLoads(state: VisitState, extra: number, now: Date): VisitState {
  if (!(extra > 0)) return state;
  const day = dayOf(now);
  const used = state.auto?.day === day ? state.auto.pageLoads : 0;
  return { ...state, auto: { day, pageLoads: used + Math.floor(extra) } };
}

/**
 * The orders a clicked run visits: a random few of the pending ones. Only an
 * order whose page was read in the last half hour is left out, so a click
 * right after a run that read nothing visits those orders again. Orders no
 * run was sent to lately go first.
 */
export function pickClick(state: VisitState, now: Date, cap = CLICK_MAX_ORDERS, rnd: () => number = Math.random): { visits: Visit[]; state: VisitState } {
  const entries = state.entries.map(e => ({ ...e }));
  const open = entries.filter(e => e.stages.length && !(e.lastReadAt && now.getTime() - ms(e.lastReadAt) < CLICK_RECENT_READ_MS));
  const pool = [...shuffle(open.filter(e => !recent(e, now)), rnd), ...shuffle(open.filter(e => recent(e, now)), rnd)].slice(0, Math.max(0, cap));
  for (const e of pool) e.lastVisitAt = now.toISOString();
  return {
    visits: pool.map(e => ({ orderNumber: e.order, url: e.url ?? null, stages: [...e.stages] })),
    state: pool.length ? { ...state, entries } : state,
  };
}

/**
 * The tracker read a page of this order just now. The 6-hour spacing counts
 * from here too, so a read that lands after its run was settled as unread
 * (the page was sent late) does not get the order visited again 20 minutes on.
 */
export function markRead(state: VisitState, order: string, now: Date): VisitState {
  if (!state.entries.some(e => digits(e.order) === digits(order))) return state;
  const at = now.toISOString();
  return {
    ...state,
    entries: state.entries.map(e => (digits(e.order) === digits(order) ? { ...e, lastReadAt: at, lastVisitAt: at, fails: 0 } : e)),
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

export const needsListRead = (state: VisitState, now: Date, everyMs = LIST_READ_EVERY_MS) =>
  !state.listReadAt || now.getTime() - new Date(state.listReadAt).getTime() >= everyMs;
export const markListRead = (state: VisitState, now: Date): VisitState => ({ ...state, listReadAt: now.toISOString() });
export const pauseAuto = (state: VisitState, now: Date): VisitState => ({ ...state, pausedAt: now.toISOString() });
export const resumeAuto = (state: VisitState): VisitState => { const { pausedAt: _p, ...rest } = state; return rest; };
