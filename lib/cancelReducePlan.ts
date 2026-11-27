// What a cancelled order's released units do to its groups, planned without
// I/O so it can be unit tested (the pattern of lib/bfmrCancelPlan.ts).
//
//   - BuyingGroup: the commitment's quantity on BG drops by the released units,
//     never below the units other live orders still hold. Skipped, with a
//     reason, when BG's own state says it can't or shouldn't be edited.
//   - Partial cancel emails: the one linked line the email names (when it names
//     exactly one) loses the cancelled units; BFMR is cancelled only when those
//     units are a whole reserve id that is this order's alone.
//
// The outward calls are gated by the per-user setting below, off by default.

import { planBfmrCancel, type BfmrCancelPlan, type BfmrLine } from './bfmrCancelPlan.ts';

/** Per-user Setting: "true" lets a cancel change BG commitments and (partial cancels) BFMR reservations. */
export const CANCEL_REDUCE_KEY = 'cancel_reduce_groups';

export const cancelReduceOn = (value: string | null | undefined) => value === 'true';

// ---------------------------------------------------------------------------
// BuyingGroup commitment reduction
// ---------------------------------------------------------------------------

/** A BG commitment's state as read live from BG or from the last sync's stored record. */
export type BgState = {
  quantity: number;
  status: string;
  editable: boolean;
  dealActive: boolean;
  expiry: Date | null;
  dealKey: string | null;
  itemKey: string | null;
  source: 'live' | 'synced';
};

type BgRecord = { status?: unknown; editable?: unknown; deal_status?: unknown; expiry_day?: unknown; deal?: { key?: unknown } | null; item?: { key?: unknown } | null };

/** "MM-DD-YYYY" (BG's format) as a UTC date; null when it isn't one. */
export function parseBgDay(s: unknown): Date | null {
  const m = String(s ?? '').match(/^(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[3], +m[1] - 1, +m[2]));
  return Number.isNaN(d.getTime()) ? null : d;
}

const key = (v: unknown) => (typeof v === 'string' && v ? v : null);

/** A BG commitment record (live, or the `raw` JSON of a synced row) with the quantity to plan from. */
export function bgStateFrom(rec: BgRecord | null | undefined, quantity: number, source: BgState['source']): BgState | null {
  if (!rec) return null;
  return {
    quantity,
    status: String(rec.status ?? ''),
    editable: rec.editable === true,
    dealActive: rec.deal_status !== false,
    expiry: parseBgDay(rec.expiry_day),
    dealKey: key(rec.deal?.key),
    itemKey: key(rec.item?.key),
    source,
  };
}

export type BgReduceInput = {
  /** Units the cancel released from this commitment. */
  released: number;
  /** Units still linked to other live (non-cancelled) orders. */
  stillLinked: number;
  bg: BgState | null;
  now: Date;
};

export type BgReducePlan =
  | { kind: 'reduce'; from: number; to: number; dealKey: string; itemKey: string; source: BgState['source'] }
  | { kind: 'skip'; reason: string; from?: number };

const DAY_MS = 86_400_000;

export function planBgReduce(i: BgReduceInput): BgReducePlan {
  const bg = i.bg;
  if (!bg) return { kind: 'skip', reason: 'no BG record for the commitment' };
  if (!(i.released > 0)) return { kind: 'skip', reason: 'no units released', from: bg.quantity };
  if (bg.status.toUpperCase() !== 'ACTIVE') return { kind: 'skip', reason: `commitment is ${bg.status || 'not active'} on BG`, from: bg.quantity };
  if (!bg.dealActive) return { kind: 'skip', reason: 'the deal is closed on BG', from: bg.quantity };
  if (bg.expiry && bg.expiry.getTime() + DAY_MS <= i.now.getTime()) return { kind: 'skip', reason: 'the commitment has expired', from: bg.quantity };
  if (!bg.editable) return { kind: 'skip', reason: 'BG does not allow editing it', from: bg.quantity };
  if (!bg.dealKey || !bg.itemKey) return { kind: 'skip', reason: 'no BG deal or item key on file', from: bg.quantity };
  if (bg.quantity < i.released) return { kind: 'skip', reason: `BG has ${bg.quantity}, fewer than the ${i.released} released`, from: bg.quantity };
  const to = Math.max(bg.quantity - i.released, i.stillLinked, 0);
  if (to >= bg.quantity) return { kind: 'skip', reason: 'other orders still hold all of it', from: bg.quantity };
  return { kind: 'reduce', from: bg.quantity, to, dealKey: bg.dealKey, itemKey: bg.itemKey, source: bg.source };
}

export type BgOutcome = { name: string; state: 'reduced' | 'would' | 'skipped' | 'failed'; from?: number; to?: number; reason?: string };

const clip = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}…` : s);

/** One line of the cancel notification. */
export function bgOutcomeLine(o: BgOutcome): string {
  const name = clip(o.name);
  switch (o.state) {
    case 'reduced': return `BG: reduced ${name} ${o.from} → ${o.to}`;
    case 'would': return `BG: would reduce ${name} ${o.from} → ${o.to} (setting off)`;
    case 'failed': return `BG: could not reduce ${name} (${o.reason}). Reduce it on BG`;
    default: return `BG: left ${name} as is (${o.reason}). Check it on BG`;
  }
}

// ---------------------------------------------------------------------------
// Partial cancels
// ---------------------------------------------------------------------------

export type PartialLine = {
  group: 'BuyingGroup' | 'BFMR' | 'BigSky';
  /** The link row (OrderCommitmentLink / OrderBfmrLink / OrderBigSkyLink id). */
  linkId: number;
  name: string;
  quantity: number;
  /** BuyingGroup: the commitment row. BFMR: the reservation row. BigSky: the commitment row. */
  targetId: number;
};

export type PartialPlan =
  | { kind: 'hold'; reason: string }
  | { kind: 'apply'; line: PartialLine; units: number };

const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length >= 2));

/** Same product: identical words, or one name's words (3 or more) all inside the other's. */
export function sameItem(a: string, b: string): boolean {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return false;
  const [small, big] = x.size <= y.size ? [x, y] : [y, x];
  if (small.size < 3 && small.size !== big.size) return false;
  for (const w of small) if (!big.has(w)) return false;
  return true;
}

/** The email's item text ("Name (x2)" when it gives a quantity) split into name and quantity. */
export function cancelledItem(item: string | undefined): { name: string; quantity: number | null } | null {
  const t = String(item ?? '').trim();
  // "(+N more)" means other items were cancelled too: more than one line.
  if (!t || /\(\+\d+ more\)/i.test(t)) return null;
  const q = t.match(/^(.*?)\s*\(x(\d{1,3})\)$/i);
  return q ? { name: q[1].trim(), quantity: parseInt(q[2], 10) } : { name: t, quantity: null };
}

/**
 * The linked line a partial cancel email names. Only when the item matches
 * exactly one linked line, and the quantity fits it. No "(xN)" means 1 unit:
 * the parser (summarizeItems in lib/emailParse.ts) writes the count only when
 * it is more than 1, so reading it as the whole line would release too much.
 * Anything else is left for a person.
 */
export function planPartialCancel(item: string | undefined, lines: readonly PartialLine[]): PartialPlan {
  const it = cancelledItem(item);
  if (!it || !it.name) return { kind: 'hold', reason: 'the email names no single item' };
  const hits = lines.filter(l => sameItem(it.name, l.name));
  if (hits.length !== 1) return { kind: 'hold', reason: hits.length ? 'the item matches more than one linked line' : 'the item matches no linked line' };
  const line = hits[0];
  const units = it.quantity ?? 1;
  if (!(units >= 1) || units > line.quantity) return { kind: 'hold', reason: `the email cancels ${units}, the line has ${line.quantity}` };
  return { kind: 'apply', line, units };
}

/**
 * BFMR cancels by reserve id, so a partial cancel reaches BFMR only when the
 * cancelled units are exactly one whole reserve id (planBfmrCancel then checks
 * it belongs to this order alone, status, order number and price). `lines` are
 * the reservation rows as they stand before the link is reduced; `amount` is
 * the cancelled amount, the figure the price check compares to the retail total.
 */
export function planBfmrPartial(
  order: { id: number; orderNumber: string | null },
  reserveId: string | null,
  units: number,
  amount: number,
  lines: readonly BfmrLine[],
): BfmrCancelPlan {
  if (!reserveId) return { cancel: [], left: ['no BFMR reservation id on file'] };
  const group = lines.filter(l => l.reserveId === reserveId);
  const qty = group.reduce((n, l) => n + l.qty, 0);
  if (units !== qty) return { cancel: [], left: [`the cancel is ${units} of ${qty} reserved units, BFMR cancels a whole reservation only`] };
  return planBfmrCancel({ id: order.id, orderNumber: order.orderNumber, cost: amount > 0 ? amount : null }, group);
}

/** The dated order note that records a partial cancel (also the marker that stops it applying twice). */
export function partialNoteLine(day: string, units: number, item: string, amount: number): string {
  const name = item.replace(/\s+/g, ' ').trim().slice(0, 60);
  return `Partial cancel ${day}: ${units}× ${name}${amount > 0 ? `, $${amount.toFixed(2)} cancelled` : ''}. Order cost not changed: fix it`;
}
