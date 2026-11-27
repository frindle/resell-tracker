import { parseState, autoGaveUp } from './amazonVisitPlan.ts';

// Which orders are waiting on an automatic page scrape, so the order says so
// instead of looking like the import failed. Pure: lib/pendingLookupsDb.ts
// loads the inputs.

export type PendingLookup = {
  kind: 'shipping' | 'order';
  /** ISO time the scrape is scheduled for; null when no time is known (store page lookups). */
  dueAt: string | null;
  /** Automatic visits are paused until the user clicks Sync Amazon. */
  paused: boolean;
  /** Automatic runs stopped trying this order. */
  gaveUp: boolean;
};

export type LookupOrder = { orderNumber: string | null; trackingNumbers: string | null; cancelled?: boolean };

const digits = (s: string | null | undefined) => String(s ?? '').replace(/\D/g, '');

/** Amazon visit queue + the order numbers of waiting store page lookups -> pending lookup per order number (digits). */
export function pendingLookupsFor(
  stateJson: string | null | undefined,
  orders: readonly LookupOrder[],
  now: Date,
  storeLookupOrders: readonly string[] = [],
): Map<string, PendingLookup> {
  const state = parseState(stateJson);
  const wanted = new Map(orders.filter(o => digits(o.orderNumber)).map(o => [digits(o.orderNumber), o]));
  const out = new Map<string, PendingLookup>();
  for (const e of state.entries) {
    const key = digits(e.order);
    const o = wanted.get(key);
    if (!o || o.cancelled || !e.stages.length) continue;
    const kind = e.stages.includes('track') ? 'shipping' : 'order';
    if (kind === 'shipping' && String(o.trackingNumbers ?? '').trim()) continue;
    out.set(key, { kind, dueAt: e.dueAt ?? null, paused: !!state.pausedAt, gaveUp: autoGaveUp(e, now) });
  }
  for (const n of storeLookupOrders) {
    const key = digits(n);
    const o = wanted.get(key);
    if (!o || o.cancelled || out.has(key)) continue;
    out.set(key, { kind: 'order', dueAt: null, paused: false, gaveUp: false });
  }
  return out;
}

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** Badge text. `short` drops the kind word (list rows); the long form is for the detail view and tooltips. Time is in the runtime's local zone. */
export function pendingLookupLabel(p: PendingLookup, form: 'short' | 'long', now: Date = new Date()): string {
  const noun = form === 'short' ? 'Scrape' : p.kind === 'shipping' ? 'Shipping Scrape' : 'Order Scrape';
  if (p.gaveUp) return `${noun} Gave Up`;
  if (p.paused) return form === 'short' ? `${noun} Paused` : `${noun} Paused: click Sync Amazon`;
  const due = p.dueAt ? new Date(p.dueAt) : null;
  if (!due || isNaN(due.getTime())) return `${noun} Queued`;
  if (due <= now) return `${noun} Due`;
  return `${noun} Scheduled ${hhmm(due)}`;
}
