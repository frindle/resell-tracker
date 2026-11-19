// Match one order to the open reservation or commitment it was bought for.
// Pure: no database, no clock (callers pass `nowMs`), unit tested.
//
// Candidates come from three groups, each with the rule the app itself uses:
//   BFMR    a reservation with no links, not dismissed, still waiting for its
//           order: status reserved or purchased (rank 1 in lib/bfmr.ts
//           BFMR_STATUS_RANK; shipped, received, processed, paid, returned,
//           set aside and the rest already have their goods)
//   BG      count - assigned, where assigned is the sum of ALL link quantities
//           (fulfilled is a subset of assigned), open status, not past its
//           expiry day: app/api/buyinggroup/commitments/route.ts and
//           lib/bgCommitmentLinkable.ts linkableCommitments
//   BigSky  commitmentAmount - fulfilled (not BigSky's own commitmentsRemaining,
//           see app/bigsky/page.tsx openUnits) minus the units already set
//           aside on orders, not past its expiry day
// Matching is strict: when unsure there is no link. Two names match only when
// their model tokens, size, capacity and every colour, edition, connectivity,
// condition or bundle word agree exactly (a word only one side has is a
// conflict). The caller does the writing and never replaces a manual link.
import { isExpiryDayPast } from './bgCommitmentLinkable.ts';

export type Group = 'BFMR' | 'BG' | 'BigSky';

export type Candidate = {
  group: Group;
  /** Row id in the group's own table. */
  id: number;
  name: string;
  /** Units the candidate can still take. */
  remaining: number;
  /**
   * When the reservation or commitment was made (ms). Undefined = the group has
   * no such date (BFMR), so no date check. Null = it has one but it is unknown:
   * an order is never linked to it.
   */
  createdAt?: number | null;
};

export type MatchOrder = {
  itemDescription: string | null;
  /** Units on the order, or null when nothing real says (the item name is not a source). */
  quantity: number | null;
  /** The order's date (ms). Needed for any candidate that has a createdAt. */
  orderDateMs?: number | null;
};

export type MatchOutcome =
  | { kind: 'link'; candidate: Candidate }
  | { kind: 'none' }
  | { kind: 'several'; candidates: Candidate[] }
  | { kind: 'too-many'; candidate: Candidate }
  | { kind: 'no-item' }
  /** The name says several units ("(x3)") and nothing real confirms how many. */
  | { kind: 'qty-unknown' };

// --- candidate builders (the remaining-units rules) -------------------------

// Reserved and purchased are the only statuses where the goods are still to be
// bought (BFMR_STATUS_RANK 1 in lib/bfmr.ts).
const WAITING_BFMR = new Set(['reserved', 'purchased']);

export type BfmrRow = { id: number; itemName: string | null; dealTitle: string | null; qty: number; status: string; linkCount: number };
export function bfmrCandidates(rows: readonly BfmrRow[]): Candidate[] {
  return rows
    .filter(r => r.linkCount === 0 && WAITING_BFMR.has(r.status.toLowerCase().trim()) && r.qty > 0)
    .map(r => ({ group: 'BFMR' as const, id: r.id, name: r.itemName || r.dealTitle || '', remaining: r.qty }));
}

export type BgRow = { id: number; dealTitle: string; count: number; assignedQty: number; status: string; expiryDay: Date | string | null; createdDt: Date | null };
const OPEN_BG = new Set(['ACTIVE', 'PARTIALLY FULFILLED']);
export function bgCandidates(rows: readonly BgRow[], nowMs: number): Candidate[] {
  return rows
    .filter(r => OPEN_BG.has(r.status) && !isExpiryDayPast(r.expiryDay, nowMs))
    .map(r => ({ group: 'BG' as const, id: r.id, name: r.dealTitle, remaining: r.count - r.assignedQty, createdAt: r.createdDt ? r.createdDt.getTime() : null }))
    .filter(c => c.remaining > 0);
}

const DAY_MS = 86_400_000;
export type BigSkyRow = { id: number; itemName: string; commitmentAmount: number; fulfilled: number; plannedQty: number; status: string; dealExpiration: Date | null; dealCreated: Date | null; creationDate: Date | null };
export function bigskyCandidates(rows: readonly BigSkyRow[], nowMs: number): Candidate[] {
  return rows
    // BigSky's expiry is the end of that day, as the order page treats it.
    .filter(r => r.status !== 'FULFILLED' && !(r.dealExpiration != null && r.dealExpiration.getTime() + DAY_MS <= nowMs))
    .map(r => ({ group: 'BigSky' as const, id: r.id, name: r.itemName, remaining: r.commitmentAmount - r.fulfilled - r.plannedQty, createdAt: (r.dealCreated ?? r.creationDate)?.getTime() ?? null }))
    .filter(c => c.remaining > 0);
}

// --- item names -------------------------------------------------------------

const STOP = new Set(['the', 'for', 'new', 'apple', 'inch', 'usb', 'model', 'latest', 'wireless', 'case', 'only', 'a', 'an', 'of', 'to', 'by', 'or']);
const VARIANTS = new Set(['pro', 'max', 'plus', 'mini', 'ultra', 'air', 'lite', 'se', 'fe', 'xl']);
// Words that name a different product when only one side has them.
const COLOURS = ['black', 'white', 'blue', 'purple', 'red', 'green', 'pink', 'silver', 'gold', 'gray', 'orange', 'yellow', 'teal',
  'graphite', 'midnight', 'starlight', 'titanium', 'natural', 'beige', 'brown', 'cream', 'lavender', 'violet', 'navy', 'cyan',
  'coral', 'sage', 'mint', 'bronze', 'copper', 'rose', 'ivory', 'space', 'obsidian', 'charcoal', 'sand', 'desert'];
const EDITIONS = ['digital', 'disc', 'edition', 'standard', 'limited', 'special', 'collector', 'collectors', 'anniversary', 'deluxe', 'ultimate', 'premium'];
const CONNECTIVITY = ['wifi', 'cellular', 'gps', 'lte', '5g', 'bluetooth', 'wired', 'unlocked', 'verizon', 'att', 'tmobile'];
const CONDITION = ['refurbished', 'renewed', 'used', 'open', 'box', 'sealed'];
const BUNDLE = ['bundle', 'kit', 'combo', 'set', 'pack', 'with', 'and', 'includes', 'including'];
const MODIFIERS = new Set([...COLOURS, ...EDITIONS, ...CONNECTIVITY, ...CONDITION, ...BUNDLE]);

export type Terms = {
  capacity: Set<string>; size: Set<string>;
  /** Bare numbers and number-bearing codes (16, 16e, m4, a2894): the model. */
  model: Set<string>;
  variants: Set<string>;
  /** Colour, edition, connectivity, condition and bundle words. */
  modifiers: Set<string>;
  words: Set<string>;
};

/** A "(x3)" count, or a trailing "x3", in an item name (the count, or 1 when there is none). */
export function nameQuantityMark(name: string | null | undefined): number {
  const m = /\(\s*x\s?(\d{1,3})\s*\)|\sx\s?(\d{1,3})\s*$/i.exec(name ?? '');
  return m ? Math.max(1, parseInt(m[1] ?? m[2], 10)) : 1;
}

/** The parts of an item name that tell models apart, and its plain words. */
export function itemTerms(name: string | null | undefined): Terms {
  let s = ` ${(name ?? '').toLowerCase().replace(/[‘’]/g, "'").replace(/'s\b/g, '').replace(/[“”″]/g, '"').replace(/\bin\./g, 'in')} `;
  // The count marker is not part of the product.
  s = s.replace(/\(\s*x\s?\d{1,3}\s*\)|\sx\s?\d{1,3}\s*$/g, ' ');
  s = s.replace(/\bwi[\s-]?fi\b/g, ' wifi ').replace(/\bgrey\b/g, ' gray ').replace(/\bt-mobile\b/g, ' tmobile ')
    .replace(/\bat&t\b/g, ' att ').replace(/\bw\//g, ' with ').replace(/[+&]/g, ' and ');
  const capacity = new Set<string>();
  const size = new Set<string>();
  const model = new Set<string>();
  const variants = new Set<string>();
  const modifiers = new Set<string>();
  const words = new Set<string>();
  const take = (re: RegExp, into: Set<string>, fmt: (m: RegExpExecArray) => string) => {
    s = s.replace(re, (...a) => { const m = a as unknown as RegExpExecArray; into.add(fmt(m)); return ' '; });
  };
  // 256GB, 1 TB. Storage and memory both count: an 8GB/256GB pair is two entries.
  take(/(\d+(?:\.\d+)?)\s?(gb|tb)\b/g, capacity, m => `${m[1]}${m[2]}`);
  // 11", 13-inch, 14 in
  take(/(\d+(?:\.\d+)?)\s?(?:"|-?inch(?:es)?\b|in\b)/g, size, m => `${m[1]}in`);
  // 3rd generation, 10th gen
  take(/(\d+)(?:st|nd|rd|th)\s*(?:gen(?:eration)?)?\b/g, model, m => m[1]);
  for (const w of s.split(/[^a-z0-9]+/).filter(Boolean)) {
    if (/^\d+$/.test(w)) model.add(w);
    else if (/[a-z]/.test(w) && /\d/.test(w)) { if (MODIFIERS.has(w)) modifiers.add(w); else model.add(w); } // m4, a2894, 16e
    else if (VARIANTS.has(w)) variants.add(w);
    else if (MODIFIERS.has(w)) modifiers.add(w);
    else if (!STOP.has(w)) words.add(w); // one letter counts: Series X is not Series S
  }
  return { capacity, size, model, variants, modifiers, words };
}

const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every(x => b.has(x));

/** True when the two names are confidently the same product. */
export function itemsMatch(orderItem: string | null | undefined, candidateName: string | null | undefined): boolean {
  const a = itemTerms(orderItem);
  const b = itemTerms(candidateName);
  // Every distinguishing term must agree exactly: a side that is silent about
  // a size, capacity, model number, variant, colour, edition, connectivity or
  // bundle word is a different product from one that states it.
  for (const k of ['capacity', 'size', 'model', 'variants', 'modifiers'] as const) {
    if (!same(a[k], b[k])) return false;
  }
  const smaller = Math.min(a.words.size, b.words.size);
  if (smaller === 0) return false;
  // A plain word only one side has (OLED, Slim, X vs S, Active Noise Cancellation)
  // names a different product, so the word sets must agree exactly. A missed
  // link is fine; a wrong one takes the wrong payout.
  if (!same(a.words, b.words)) return false;
  // A model token, size or capacity in common needs one shared word; plain names two.
  const anchored = a.model.size > 0 || a.size.size > 0 || a.capacity.size > 0;
  return smaller >= (anchored ? 1 : 2);
}

// --- the decision -----------------------------------------------------------

export function matchOrder(order: MatchOrder, candidates: readonly Candidate[]): MatchOutcome {
  if (!order.itemDescription || !order.itemDescription.trim()) return { kind: 'no-item' };
  const real = order.quantity != null && Number.isInteger(order.quantity) && order.quantity > 0 ? order.quantity : null;
  // Only a real quantity is trusted. Without one, a name that says "(xN)" is not linked.
  if (real == null && nameQuantityMark(order.itemDescription) > 1) return { kind: 'qty-unknown' };
  const qty = real ?? 1;
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  // An order can only have been bought for a reservation or commitment that
  // already existed on the order's day.
  const dated = candidates.filter(c => c.createdAt === undefined
    || (c.createdAt != null && order.orderDateMs != null && day(order.orderDateMs) >= day(c.createdAt)));
  const named = dated.filter(c => itemsMatch(order.itemDescription, c.name));
  if (named.length === 0) return { kind: 'none' };
  const fits = named.filter(c => c.remaining >= qty);
  if (fits.length === 1) return { kind: 'link', candidate: fits[0] };
  if (fits.length > 1) return { kind: 'several', candidates: fits };
  // Every name match is too small for the order.
  return { kind: 'too-many', candidate: named.reduce((best, c) => (c.remaining > best.remaining ? c : best)) };
}
