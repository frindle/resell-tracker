// Match one order to the open reservation or commitment it was bought for.
// Pure: no database, no clock (callers pass `nowMs`), unit tested.
//
// Candidates come from three groups:
//   BFMR    a reservation with no links that is not cancelled
//   BG      a commitment where count - fulfilled - linked is above 0 and the
//           commitment has not expired
//   BigSky  a commitment with commitmentsRemaining above 0 that has not expired
// The order's item name has to agree with the candidate's on model, size and
// capacity (11" is not 13", 256GB is not 512GB), and the order's units cannot
// exceed what the candidate has left. Exactly one candidate that passes both
// is a link; none, several, or one that is too small is an alert, never a
// guess. The caller does the writing and never replaces a manual link.
import { isExpiryDayPast } from './bgCommitmentLinkable.ts';

export type Group = 'BFMR' | 'BG' | 'BigSky';

export type Candidate = {
  group: Group;
  /** Row id in the group's own table. */
  id: number;
  name: string;
  /** Units the candidate can still take. */
  remaining: number;
};

export type MatchOrder = {
  itemDescription: string | null;
  /** Units on the order; 1 when the order does not say. */
  quantity: number;
};

export type MatchOutcome =
  | { kind: 'link'; candidate: Candidate }
  | { kind: 'none' }
  | { kind: 'several'; candidates: Candidate[] }
  | { kind: 'too-many'; candidate: Candidate }
  | { kind: 'no-item' };

// --- candidate builders (the remaining-units rules) -------------------------

const DONE_BFMR = new Set(['cancelled', 'canceled', 'closed']);

export type BfmrRow = { id: number; itemName: string | null; dealTitle: string | null; qty: number; status: string; linkCount: number };
export function bfmrCandidates(rows: readonly BfmrRow[]): Candidate[] {
  return rows
    .filter(r => r.linkCount === 0 && !DONE_BFMR.has(r.status.toLowerCase()) && r.qty > 0)
    .map(r => ({ group: 'BFMR' as const, id: r.id, name: r.itemName || r.dealTitle || '', remaining: r.qty }));
}

export type BgRow = { id: number; dealTitle: string; count: number; fulfilled: number; linkedQty: number; status: string; expiryDay: Date | string | null };
const OPEN_BG = new Set(['ACTIVE', 'PARTIALLY FULFILLED']);
export function bgCandidates(rows: readonly BgRow[], nowMs: number): Candidate[] {
  return rows
    .filter(r => OPEN_BG.has(r.status) && !isExpiryDayPast(r.expiryDay, nowMs))
    .map(r => ({ group: 'BG' as const, id: r.id, name: r.dealTitle, remaining: r.count - r.fulfilled - r.linkedQty }))
    .filter(c => c.remaining > 0);
}

const DAY_MS = 86_400_000;
export type BigSkyRow = { id: number; itemName: string; commitmentsRemaining: number; dealExpiration: Date | null };
export function bigskyCandidates(rows: readonly BigSkyRow[], nowMs: number): Candidate[] {
  return rows
    // BigSky's expiry is the end of that day, as the order page treats it.
    .filter(r => r.commitmentsRemaining > 0 && !(r.dealExpiration != null && r.dealExpiration.getTime() + DAY_MS <= nowMs))
    .map(r => ({ group: 'BigSky' as const, id: r.id, name: r.itemName, remaining: r.commitmentsRemaining }));
}

// --- item names -------------------------------------------------------------

const STOP = new Set(['the', 'and', 'for', 'with', 'new', 'apple', 'inch', 'usb', 'model', 'latest', 'wireless', 'case', 'only', 'pack']);
const VARIANTS = new Set(['pro', 'max', 'plus', 'mini', 'ultra', 'air', 'lite', 'se', 'fe', 'xl']);

export type Terms = { capacity: Set<string>; size: Set<string>; generation: Set<string>; codes: Set<string>; variants: Set<string>; words: Set<string> };

/** The parts of an item name that tell models apart, and its plain words. */
export function itemTerms(name: string | null | undefined): Terms {
  let s = ` ${(name ?? '').toLowerCase().replace(/[“”″]/g, '"').replace(/\bin\./g, 'in')} `;
  const capacity = new Set<string>();
  const size = new Set<string>();
  const generation = new Set<string>();
  const codes = new Set<string>();
  const variants = new Set<string>();
  const words = new Set<string>();
  const take = (re: RegExp, into: Set<string>, fmt: (m: RegExpExecArray) => string) => {
    s = s.replace(re, (...a) => { const m = a as unknown as RegExpExecArray; into.add(fmt(m)); return ' '; });
  };
  // 256GB, 1 TB. Storage and memory both count: an 8GB/256GB pair is two entries.
  take(/(\d+(?:\.\d+)?)\s?(gb|tb)\b/g, capacity, m => `${m[1]}${m[2]}`);
  // 11", 13-inch, 14 in
  take(/(\d+(?:\.\d+)?)\s?(?:"|-?inch(?:es)?\b|in\b)/g, size, m => `${m[1]}in`);
  // 3rd generation, 10th gen
  take(/(\d+)(?:st|nd|rd|th)\s*(?:gen(?:eration)?)?\b/g, generation, m => m[1]);
  for (const w of s.split(/[^a-z0-9]+/).filter(Boolean)) {
    if (/^\d{1,2}$/.test(w)) generation.add(w);
    else if (/[a-z]/.test(w) && /\d/.test(w)) codes.add(w); // m4, a2894, mw0e3ll
    else if (VARIANTS.has(w)) variants.add(w);
    else if (w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)) words.add(w);
  }
  return { capacity, size, generation, codes, variants, words };
}

const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every(x => b.has(x));
// Two sides that both state a term must state the same terms. One side silent
// is not a conflict; the word overlap below still has to carry the match.
const conflicts = (a: Set<string>, b: Set<string>) => a.size > 0 && b.size > 0 && !same(a, b);

/** True when the two names can be the same product. */
export function itemsMatch(orderItem: string | null | undefined, candidateName: string | null | undefined): boolean {
  const a = itemTerms(orderItem);
  const b = itemTerms(candidateName);
  if (conflicts(a.capacity, b.capacity) || conflicts(a.size, b.size) || conflicts(a.generation, b.generation)) return false;
  // "Pro" vs "Pro Max", or "Pro" vs nothing, are different products.
  if (!same(a.variants, b.variants)) return false;
  if (a.codes.size && b.codes.size && ![...a.codes].some(c => b.codes.has(c))) return false;
  const shared = [...a.words].filter(w => b.words.has(w)).length;
  const smaller = Math.min(a.words.size, b.words.size);
  // Names with a code or a size in common need one shared word; plain names two.
  const anchored = (a.codes.size && b.codes.size) || (a.size.size && b.size.size) || (a.capacity.size && b.capacity.size);
  if (smaller === 0) return false;
  return shared >= Math.min(smaller, anchored ? 1 : 2);
}

// --- the decision -----------------------------------------------------------

export function matchOrder(order: MatchOrder, candidates: readonly Candidate[]): MatchOutcome {
  if (!order.itemDescription || !order.itemDescription.trim()) return { kind: 'no-item' };
  const qty = Number.isInteger(order.quantity) && order.quantity > 0 ? order.quantity : 1;
  const named = candidates.filter(c => itemsMatch(order.itemDescription, c.name));
  if (named.length === 0) return { kind: 'none' };
  const fits = named.filter(c => c.remaining >= qty);
  if (fits.length === 1) return { kind: 'link', candidate: fits[0] };
  if (fits.length > 1) return { kind: 'several', candidates: fits };
  // Every name match is too small for the order.
  return { kind: 'too-many', candidate: named.reduce((best, c) => (c.remaining > best.remaining ? c : best)) };
}
