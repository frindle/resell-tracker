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
// When unsure there is no link. itemsMatch (the group fill) needs every
// distinguishing term to agree exactly. The auto-link (matchOrder) uses
// itemFits, which allows the extra words of a long store title but not a
// conflict, and then needs the order total to be a whole number of the
// candidate's unit price; that number is the units linked. Only the order's own
// group is tried when it has a buyer. The caller does the writing and never
// replaces a manual link.
import { isExpiryDayPast } from './bgCommitmentLinkable.ts';
import { isReplaceableDescription } from './gapFill.ts';

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
  /** What one unit pays (BFMR retail price, BG price, BigSky deal price); unknown = no money check. */
  unitPrice?: number | null;
  /**
   * Which deal item the row is for (BFMR deal+item, BG or BigSky deal). Rows of one group with the same
   * key and unit price are the same item, so an order that fits them is not "several candidates".
   */
  itemKey?: string | null;
  /** Normalised UPC, ASIN or model/part numbers the row carries (see itemIdentifiers). */
  identifiers?: readonly string[];
};

export type MatchOrder = {
  itemDescription: string | null;
  /** Units on the order, or null when nothing real says (the item name is not a source). */
  quantity: number | null;
  /** The order's date (ms). Needed for any candidate that has a createdAt. */
  orderDateMs?: number | null;
  /** What the order paid before tax (subtotal, else cost). With a unit price it gives the units. */
  amount?: number | null;
  /** The order's buyer name. Undefined = not checked; null = none set (any group). */
  buyer?: string | null;
  /** Items a category placeholder named before the real title came ("Laptops (2 items)" → 2). */
  itemCount?: number | null;
  /** UPC, ASIN or part numbers known for the order beyond its title (a package's ASIN). The title's own are read too. */
  identifiers?: readonly string[];
};

/** One reservation or commitment the order's units go to. */
export type Allocation = { candidate: Candidate; quantity: number };

/**
 * Why nothing fit: no open row at all; the order's buyer is not a group; the buyer's group has no open
 * row; none existed on the order's day; or the names differ.
 */
export type NoneDetail = 'no-open-rows' | 'buyer-not-a-group' | 'group-has-none' | 'date' | 'name';

export type MatchOutcome =
  /** candidate and quantity are the first allocation; allocations lists every row (an order can cover several). */
  | { kind: 'link'; candidate: Candidate; quantity: number; allocations: Allocation[]; by: 'identifier' | 'name' }
  | { kind: 'none'; detail: NoneDetail }
  | { kind: 'several'; candidates: Candidate[] }
  | { kind: 'too-many'; candidate: Candidate }
  | { kind: 'no-item' }
  /** The name says several units ("(x3)") and nothing real confirms how many. */
  | { kind: 'qty-unknown' }
  /** Names fit, but the order total is not a whole number of any fitting unit price. Not alerted. */
  | { kind: 'price-off' }
  /** The placeholder said several items and nothing confirms the units. Not alerted. */
  | { kind: 'units-unconfirmed' };

// --- candidate builders (the remaining-units rules) -------------------------

// Reserved and purchased are the only statuses where the goods are still to be
// bought (BFMR_STATUS_RANK 1 in lib/bfmr.ts).
const WAITING_BFMR = new Set(['reserved', 'purchased']);

export type BfmrRow = {
  id: number; itemName: string | null; dealTitle: string | null; qty: number; status: string; linkCount: number; retailPrice?: number | null;
  /** Units already on order links. Absent = 0 when linkCount is 0, else the row is treated as full. */
  linkedQty?: number;
  dealId?: string | null; itemId?: string | null; modelNumber?: string | null;
};
export function bfmrCandidates(rows: readonly BfmrRow[]): Candidate[] {
  return rows
    .filter(r => WAITING_BFMR.has(r.status.toLowerCase().trim()))
    // A reservation part-covered by an earlier order still takes the rest; one with links of unknown size is left alone.
    .map(r => ({ r, remaining: r.qty - (r.linkedQty ?? (r.linkCount === 0 ? 0 : r.qty)) }))
    .filter(x => x.remaining > 0)
    .map(({ r, remaining }) => ({
      group: 'BFMR' as const, id: r.id, name: r.itemName || r.dealTitle || '', remaining, unitPrice: r.retailPrice ?? null,
      itemKey: r.dealId && r.itemId ? `${r.dealId}|${r.itemId}` : null,
      identifiers: structuredIdentifiers(r.modelNumber, `${r.itemName ?? ''} ${r.dealTitle ?? ''}`),
    }));
}

export type BgRow = { id: number; dealTitle: string; count: number; assignedQty: number; status: string; expiryDay: Date | string | null; createdDt: Date | null; price?: number | null; dealId?: string | null };
const OPEN_BG = new Set(['ACTIVE', 'PARTIALLY FULFILLED']);
export function bgCandidates(rows: readonly BgRow[], nowMs: number): Candidate[] {
  return rows
    .filter(r => OPEN_BG.has(r.status) && !isExpiryDayPast(r.expiryDay, nowMs))
    .map(r => ({ group: 'BG' as const, id: r.id, name: r.dealTitle, remaining: r.count - r.assignedQty, createdAt: r.createdDt ? r.createdDt.getTime() : null, unitPrice: r.price ?? null, itemKey: r.dealId ?? null, identifiers: structuredIdentifiers(null, r.dealTitle) }))
    .filter(c => c.remaining > 0);
}

const DAY_MS = 86_400_000;
export type BigSkyRow = { id: number; itemName: string; commitmentAmount: number; fulfilled: number; plannedQty: number; status: string; dealExpiration: Date | null; dealCreated: Date | null; creationDate: Date | null; dealPrice?: number | null; dealId?: string | null; itemUpc?: string | null };
export function bigskyCandidates(rows: readonly BigSkyRow[], nowMs: number): Candidate[] {
  return rows
    // BigSky's expiry is the end of that day, as the order page treats it.
    .filter(r => r.status !== 'FULFILLED' && !(r.dealExpiration != null && r.dealExpiration.getTime() + DAY_MS <= nowMs))
    .map(r => ({ group: 'BigSky' as const, id: r.id, name: r.itemName, remaining: r.commitmentAmount - r.fulfilled - r.plannedQty, createdAt: (r.dealCreated ?? r.creationDate)?.getTime() ?? null, unitPrice: r.dealPrice ?? null, itemKey: r.dealId ?? null, identifiers: structuredIdentifiers(r.itemUpc, r.itemName) }))
    .filter(c => c.remaining > 0);
}

// --- item names -------------------------------------------------------------

const STOP = new Set(['the', 'for', 'new', 'apple', 'inch', 'usb', 'model', 'latest', 'wireless', 'case', 'only', 'a', 'an', 'of', 'to', 'by', 'or']);
const VARIANTS = new Set(['pro', 'max', 'plus', 'mini', 'ultra', 'air', 'lite', 'se', 'fe', 'xl']);
// Words that name a different product when only one side has them.
const COLOURS = ['black', 'white', 'blue', 'purple', 'red', 'green', 'pink', 'silver', 'gold', 'gray', 'orange', 'yellow', 'teal',
  'graphite', 'midnight', 'starlight', 'titanium', 'natural', 'beige', 'brown', 'cream', 'lavender', 'violet', 'navy', 'cyan',
  'coral', 'sage', 'mint', 'bronze', 'copper', 'rose', 'ivory', 'space', 'jet', 'obsidian', 'berry', 'fog', 'charcoal', 'sand', 'desert'];
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

/** A "(x3)" count, or a trailing "x3" or "×3", in an item name (the count, or 1 when there is none). */
export function nameQuantityMark(name: string | null | undefined): number {
  const m = /\(\s*[x×]\s?(\d{1,3})\s*\)|\s[x×]\s?(\d{1,3})\s*$/i.exec(name ?? '');
  return m ? Math.max(1, parseInt(m[1] ?? m[2], 10)) : 1;
}

/** The parts of an item name that tell models apart, and its plain words. */
export function itemTerms(name: string | null | undefined): Terms {
  let s = ` ${(name ?? '').toLowerCase().replace(/[‘’]/g, "'").replace(/'s\b/g, '').replace(/[“”″]/g, '"').replace(/\bin\./g, 'in')} `;
  // The count marker is not part of the product.
  s = s.replace(/\(\s*[x×]\s?\d{1,3}\s*\)|\s[x×]\s?\d{1,3}\s*$/g, ' ');
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

// --- the auto-link fit ------------------------------------------------------
// Store titles and deal titles are both long marketing text, so the auto-link
// does not ask for the same words. It asks for no conflict on anything that
// tells two products apart, enough plain words in common, and (in matchOrder)
// an order total that is a whole number of the candidate's unit price.

// A different product when only one side says it.
const STRICT = new Set(['anc', 'cellular', 'lte', '5g', 'verizon', 'att', 'tmobile', 'refurbished', 'renewed', 'used',
  'bundle', 'combo', 'pack', 'oled', 'slim', 'lcd']);
// Disc and digital conflict with each other; a title that says neither is left to the price.
const DISC = new Set(['digital', 'disc']);
// A name whose product part says one of these is an accessory, not the device it fits.
const ACCESSORY = new Set(['controller', 'charger', 'cable', 'adapter', 'remote', 'dock', 'stand', 'cover', 'strap', 'mount']);
// What follows these in a part is what the item fits or comes with, not what it is.
const TAIL = new Set(['for', 'includes', 'including', 'included', 'compatible']);
// A brand alone does not say which product a name is.
const BRANDS = new Set(['microsoft', 'sony', 'samsung', 'google', 'amazon', 'intel', 'amd', 'nintendo', 'hp', 'dell', 'lenovo',
  'asus', 'acer', 'msi', 'lg', 'tcl', 'bose', 'beats', 'meta', 'garmin', 'nvidia']);
// Filler and generic nouns: one title has them, the other words them differently.
const FILLER = new Set([...STOP, 'with', 'and', 'includes', 'including', 'included', 'gps', 'wifi', 'bluetooth', 'wired',
  'standard', 'edition', 'open', 'box', 'sealed', 'laptop', 'notebook', 'computer', 'pc', 'console', 'system', 'smartwatch',
  'device', 'tablet', 'gaming', 'streaming', 'player', 'earbuds', 'headphones', 'video', 'smart', 'in', 'on', 'at', 'from',
  'is', 'up', 'set', 'more', 'windows']);
const COLOUR_WORDS = new Set(COLOURS);
// Share of the shorter name's plain words the other must have.
const FIT_SHARE = 0.6;

type FitTerms = {
  capacity: Set<string>; size: Set<string>; colours: Set<string>; strict: Set<string>; variants: Set<string>; disc: Set<string>;
  /** Watch band size: "S/M" → sm. */
  band: Set<string>;
  /** The number or single letter right after a word: "series 11", "series x", "switch 2". */
  after: Map<string, Set<string>>;
  /** Letter-and-digit codes by shape: "m4" → m#: {4}, "46mm" → #mm: {46}, "3rd" → #ord: {3}. */
  codes: Map<string, Set<string>>;
  words: Set<string>;
  /** Words never followed by a number or letter: "SE" in "Watch SE (2024)". */
  bare: Set<string>;
  /** Every word in the head parts, variants and all. */
  headTokens: Set<string>;
  /** The words of the name's first part(s), up to one that is more than a brand: what the product is. */
  head: Set<string>;
};

function addTo<K, V>(m: Map<K, Set<V>>, k: K, v: V) {
  const s = m.get(k);
  if (s) s.add(v); else m.set(k, new Set([v]));
}

export function fitTerms(name: string | null | undefined): FitTerms {
  let s = ` ${(name ?? '').toLowerCase().replace(/[‘’]/g, "'").replace(/'s\b/g, '').replace(/[“”″]/g, '"').replace(/\bin\./g, 'in')} `;
  s = s.replace(/\(\s*[x×]\s?\d{1,3}\s*\)|\s[x×]\s?\d{1,3}\s*$/g, ' ');
  s = s.replace(/\bwi[\s-]?fi\b/g, ' wifi ').replace(/\bgrey\b/g, ' gray ').replace(/\bt-mobile\b/g, ' tmobile ')
    .replace(/\bat&t\b/g, ' att ').replace(/\bw\//g, ' with ').replace(/[+&]/g, ' and ')
    .replace(/\bpro[\s-](?:level|grade)\b/g, ' ').replace(/\b(?:active )?noise[\s-]cancel+(?:ation|ing)\b/g, ' anc ')
    .replace(/\bdisc[\s-]?free\b/g, ' digital ').replace(/\bultra[\s-](?:retina|wide)\b/g, ' ');
  const t: FitTerms = {
    capacity: new Set(), size: new Set(), colours: new Set(), strict: new Set(), variants: new Set(), disc: new Set(),
    band: new Set(), after: new Map(), codes: new Map(), words: new Set(), head: new Set(), bare: new Set(), headTokens: new Set(),
  };
  s = s.replace(/\b([sml])\s?\/\s?([sml])\b/g, (_m, a: string, b: string) => { t.band.add(a + b); return ' '; });
  s = s.replace(/(\d+(?:\.\d+)?)\s?(gb|tb)\b/g, (_m, n: string, u: string) => { t.capacity.add(n + u); return ' '; });
  s = s.replace(/(\d+(?:\.\d+)?)\s?(?:"|-?inch(?:es)?\b|in\b)/g, (_m, n: string) => { t.size.add(`${n}in`); return ' '; });
  // A bare one-decimal number is a screen size ("Dell 15.6 Laptop"); "24-core" is one spec, not "core 32".
  s = s.replace(/(?<![\d.])(\d{1,2}\.\d)(?![\d.]|\s?[a-z"])/g, (_m, n: string) => { t.size.add(`${n}in`); return ' '; });
  s = s.replace(/\b(\d+)-([a-z]{2,})\b/g, '$1$2');
  s = s.replace(/\b(\d+)(?:st|nd|rd|th)\b/g, '$1ord');
  let headDone = false;
  for (const part of s.split(/\s[-–—|]\s|[,:;()[\]]/)) {
    const all = part.split(/[^a-z0-9]+/).filter(Boolean);
    const cut = all.findIndex(w => TAIL.has(w));
    const tokens = cut < 0 ? all : all.slice(0, cut);
    const partWords: string[] = [];
    tokens.forEach((w, i) => {
      const prev = tokens[i - 1];
      const prevIsWord = prev != null && /^[a-z]{2,}$/.test(prev) && !FILLER.has(prev);
      if (/^[a-z]{2,}$/.test(w) && !(i + 1 < tokens.length && /^(?:\d+|[a-z])$/.test(tokens[i + 1]))) t.bare.add(w);
      if (/^\d+$/.test(w) || /^[a-z]$/.test(w)) {
        if (prevIsWord) addTo(t.after, prev, w);
      } else if (/\d/.test(w)) {
        if (STRICT.has(w)) t.strict.add(w);
        else addTo(t.codes, w.replace(/\d+/g, '#'), w.replace(/[^\d]+/g, ' ').trim());
      } else if (STRICT.has(w)) t.strict.add(w);
      else if (DISC.has(w)) t.disc.add(w);
      else if (VARIANTS.has(w)) t.variants.add(w);
      else if (COLOUR_WORDS.has(w)) t.colours.add(w);
      else if (!FILLER.has(w) && !MODIFIERS.has(w)) { t.words.add(w); partWords.push(w); }
    });
    if (!headDone && partWords.length) {
      for (const w of partWords) t.head.add(w);
      for (const w of tokens) if (/^[a-z]{2,}$/.test(w)) t.headTokens.add(w);
      headDone = partWords.some(w => !BRANDS.has(w));
    }
  }
  if (!headDone) { t.head.clear(); t.headTokens.clear(); }
  return t;
}

const subsetEither = (a: Set<string>, b: Set<string>) =>
  !a.size || !b.size || [...a].every(x => b.has(x)) || [...b].every(x => a.has(x));
const shareIfBoth = (a: Set<string> | undefined, b: Set<string> | undefined) =>
  !a?.size || !b?.size || [...a].some(x => b.has(x));

/**
 * True when the order's item and a reservation or commitment name are the same
 * product as far as the names can tell: nothing that tells products apart
 * disagrees, and most plain words of the shorter name are in the other.
 */
/** Why an order item and a candidate name are not the same product; null when they are. */
export function itemMisfit(orderItem: string | null | undefined, candidateName: string | null | undefined): string | null {
  // A Walmart name listing several products is not one item.
  if (/\(\+\d+ more\)/i.test(orderItem ?? '')) return 'several items';
  const a = fitTerms(orderItem);
  const b = fitTerms(candidateName);
  // Pro and Max AirPods always cancel noise; only a plain model's name sets it apart.
  if ([...a.variants, ...b.variants].some(v => v === 'pro' || v === 'max')) { a.strict.delete('anc'); b.strict.delete('anc'); }
  if (!same(a.strict, b.strict)) return 'strict';
  if (!same(a.variants, b.variants)) return 'variant';
  for (const k of ['capacity', 'size', 'band', 'disc'] as const) if (!subsetEither(a[k], b[k])) return k;
  // A commitment that names its colour takes only that colour; one that names none takes any.
  // A commitment's colour must be one the order names, when the order names any (Amazon titles often leave it out).
  if (a.colours.size && ![...b.colours].every(c => a.colours.has(c))) return 'colour';
  for (const [w, nums] of a.after) if (!shareIfBoth(nums, b.after.get(w))) return `${w} number`;
  // "Watch SE 3" against "Watch SE (2024)": in what both names say the product is, a numbered
  // generation against one that has none. A year or the other name's screen size is not a generation.
  const MEASURE = /^#(?:mm|k|hz|mp|ghz|mhz|fps|w|mah|ms|p)$/;
  const sharedModel = [...a.codes].some(([k, v]) => !MEASURE.test(k) && [...v].some(x => b.codes.get(k)?.has(x)));
  const numbered = (x: FitTerms, y: FitTerms) => !sharedModel && [...x.after].some(([w, nums]) =>
    x.headTokens.has(w) && y.headTokens.has(w) && y.bare.has(w) && !y.after.has(w)
    && [...nums].some(n => !/^(?:19|20)\d\d$/.test(n) && !y.size.has(`${n}in`)));
  if (numbered(a, b) || numbered(b, a)) return 'generation';
  const accessory = (h: Set<string>) => [...h].some(w => ACCESSORY.has(w));
  if (accessory(a.head) !== accessory(b.head)) return 'accessory';
  for (const [shape, nums] of a.codes) if (!shareIfBoth(nums, b.codes.get(shape))) return `code ${shape}`;
  const shared = [...a.words].filter(w => b.words.has(w)).length;
  if (shared === 0) return 'no shared word';
  // A shared code, number-after-word, size or capacity anchors one shared word; otherwise two.
  const anchored = [...a.codes].some(([k, v]) => [...v].some(x => b.codes.get(k)?.has(x)))
    || [...a.after].some(([k, v]) => [...v].some(x => b.after.get(k)?.has(x)))
    || [...a.size].some(x => b.size.has(x)) || [...a.capacity].some(x => b.capacity.has(x));
  // What one name says the product is, all in the other name's words, when that is more than one plain word.
  const within = (head: Set<string>, words: Set<string>) => head.size > 0 && [...head].every(w => words.has(w))
    && (anchored || [...head].filter(w => !BRANDS.has(w)).length + a.variants.size >= 2);
  if (within(a.head, b.words) || within(b.head, a.words)) return null;
  if (shared / Math.min(a.words.size, b.words.size) < FIT_SHARE) return 'few shared words';
  return shared >= (anchored ? 1 : 2) ? null : 'one shared word';
}

export function itemFits(orderItem: string | null | undefined, candidateName: string | null | undefined): boolean {
  return itemMisfit(orderItem, candidateName) === null;
}

// --- identifiers: UPC, ASIN, model and part numbers -------------------------
// These name one product regardless of how a store words its title, so they
// are tried before names. They are read out of any text (a title, a BFMR item
// name that ends in its model number, a BigSky item code), normalised so
// "MXP63LL/A" and "MXP63LLA" agree.

const UNIT_TOKEN = /^\d+(?:GB|TB|MB|HZ|MM|GHZ|MHZ|MAH|W|K|P|NM|MP|FPS|MS|IN|CM|INCH|MBPS|GBPS|CORE|PACK|CT)$/;
const SPEC_PREFIX = /^(?:I[3579]|RTX|GTX|RX|DDR|LPDDR|USB|WIFI|WI|BLUETOOTH|WINDOWS|WIN|GEN|HDMI|CORE|RYZEN|SNAPDRAGON|ULTRA|UHD|FHD|QHD|OLED|QLED|LED|LCD|HD|NVME|PCIE|SSD|EMMC)\d/;

/** UPC/EAN, ASIN and model or part numbers found in text, normalised (ids only, never the order number). */
export function itemIdentifiers(text: string | null | undefined): string[] {
  const out = new Set<string>();
  const clean = (text ?? '').toUpperCase().replace(/[\u200E\u200F\u202A-\u202E]/g, ' ');
  for (const raw of clean.split(/[\s,;()[\]{}|"'‘’“”]+/)) {
    const t = raw.replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/g, '');
    if (t.length < 6) continue;
    if (/^\d{12,14}$/.test(t)) { out.add(`upc:${t.replace(/^0+/, '')}`); continue; }
    if (/^B0[A-Z0-9]{8}$/.test(t)) { out.add(`asin:${t}`); continue; }
    const part = t.split('#')[0].replace(/[-/.]/g, '');
    if (!/^[A-Z0-9]{6,}$/.test(part) || UNIT_TOKEN.test(part) || SPEC_PREFIX.test(part) || /^\d+X\d+$/.test(part)) continue;
    const letters = (part.match(/[A-Z]/g) ?? []).length;
    const digits = (part.match(/\d/g) ?? []).length;
    if (letters >= 2 && digits >= 1) out.add(`pn:${part}`);
  }
  return [...out];
}

/**
 * A candidate's identifiers: UPCs and ASINs wherever they appear, but part numbers only from a structured
 * field (the model number or UPC the group supplies). In a free-text title a token such as 7840HS or A17PRO
 * is a spec, not a part number.
 */
export function structuredIdentifiers(field: string | null | undefined, text: string | null | undefined): string[] {
  return [...new Set([
    ...itemIdentifiers(field),
    ...itemIdentifiers(text).filter(i => !i.startsWith('pn:')),
  ])];
}

const sharesId = (a: readonly string[] | undefined, b: readonly string[] | undefined) =>
  !!a?.length && !!b?.length && a.some(x => b.includes(x));

// What an identifier match cannot override: a spec the part number would not leave open.
const HARD_MISFIT = new Set(['strict', 'variant', 'capacity', 'size', 'band', 'disc', 'colour', 'accessory', 'several items']);

// --- units from the money ---------------------------------------------------

const PRICE_TOLERANCE = 0.03;

/** Whole units an order total buys at a unit price, within 3%; null when it is not a whole number. */
export function unitsFromAmount(amount: number | null | undefined, unitPrice: number | null | undefined): number | null {
  if (amount == null || unitPrice == null || !(amount > 0) || !(unitPrice > 0)) return null;
  const r = amount / unitPrice;
  const n = Math.round(r);
  return n >= 1 && Math.abs(r - n) <= PRICE_TOLERANCE * n ? n : null;
}

/** Which groups an order's buyer allows: null = any (no buyer set), [] = none (bought for someone else). */
export function buyerGroups(buyer: string | null | undefined): readonly Group[] | null {
  if (buyer == null || !buyer.trim()) return null;
  const b = buyer.toLowerCase().replace(/[^a-z]/g, '');
  if (b.includes('bfmr')) return ['BFMR'];
  if (b.includes('buyinggroup')) return ['BG'];
  if (b.includes('bigsky')) return ['BigSky'];
  return [];
}

// --- the decision -----------------------------------------------------------

export function matchOrder(order: MatchOrder, candidates: readonly Candidate[]): MatchOutcome {
  // Blank, a store name, or a category placeholder ("Laptops (2 items)"): wait for the real title.
  if (isReplaceableDescription(order.itemDescription)) return { kind: 'no-item' };
  const real = order.quantity != null && Number.isInteger(order.quantity) && order.quantity > 0 ? order.quantity : null;
  const mark = nameQuantityMark(order.itemDescription);
  const allowed = order.buyer === undefined ? null : buyerGroups(order.buyer);
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  if (candidates.length === 0) return { kind: 'none', detail: 'no-open-rows' };
  // Only the order's own group, and only a reservation or commitment that
  // already existed on the order's day.
  const ofGroup = candidates.filter(c => allowed == null || allowed.includes(c.group));
  if (ofGroup.length === 0) return { kind: 'none', detail: allowed != null && allowed.length === 0 ? 'buyer-not-a-group' : 'group-has-none' };
  const dated = ofGroup.filter(c => c.createdAt === undefined
    || (c.createdAt != null && order.orderDateMs != null && day(order.orderDateMs) >= day(c.createdAt)));
  if (dated.length === 0) return { kind: 'none', detail: 'date' };
  // A shared UPC, ASIN or part number comes before names: when any row shares one, only those rows are tried.
  const orderIds = [...(order.identifiers ?? []), ...itemIdentifiers(order.itemDescription)];
  // A shared part number is weaker than a UPC or ASIN, so the names must still fit.
  const byId = dated.filter(c => sharesId(orderIds, c.identifiers)).filter(c => {
    const why = itemMisfit(order.itemDescription, c.name);
    if (why === null) return true;
    const strong = orderIds.some(x => !x.startsWith('pn:') && c.identifiers?.includes(x));
    return strong && !HARD_MISFIT.has(why);
  });
  const matchedBy: 'identifier' | 'name' = byId.length ? 'identifier' : 'name';
  const named = byId.length ? byId : dated.filter(c => itemFits(order.itemDescription, c.name));
  if (named.length === 0) return { kind: 'none', detail: 'name' };

  // Units per candidate. With a unit price the order total must be a whole
  // number of units (and agree with any real quantity or "(xN)" in the name);
  // without one, only a real quantity or a name that says one unit is trusted.
  const unitsFor = (c: Candidate): number | 'off' | 'unknown' => {
    if (order.amount != null && order.amount > 0 && c.unitPrice != null && c.unitPrice > 0) {
      const n = unitsFromAmount(order.amount, c.unitPrice);
      if (n == null || (real != null && real !== n) || (mark > 1 && mark !== n)) return 'off';
      return n;
    }
    if (real != null) return real;
    return mark > 1 || (order.itemCount ?? 1) > 1 ? 'unknown' : 1;
  };
  const sized = named.map(c => ({ c, units: unitsFor(c) }))
    .filter((s): s is { c: Candidate; units: number | 'unknown' } => s.units !== 'off');
  if (!sized.length) return { kind: 'price-off' };

  // Rows of one group that are the same deal item at the same price are one candidate: the order can
  // fill them in turn (oldest first), so it can cover several reservations or part of one.
  const sameItem = (a: Candidate, b: Candidate) => a.group === b.group && a.itemKey != null && a.itemKey === b.itemKey
    && (a.unitPrice ?? null) === (b.unitPrice ?? null);
  const families: (typeof sized)[] = [];
  for (const s of sized) {
    const fam = families.find(f => sameItem(f[0].c, s.c) && f[0].units === s.units);
    if (fam) fam.push(s); else families.push([s]);
  }
  if (families.length > 1) {
    // A row too small for the order does not count against the others, as before.
    const roomy = families.filter(f => f[0].units === 'unknown' || f.reduce((n, s) => n + s.c.remaining, 0) >= (f[0].units as number));
    if (roomy.length > 1) return { kind: 'several', candidates: roomy.flat().map(s => s.c) };
    if (roomy.length === 0) return tooMany(sized);
    families.splice(0, families.length, roomy[0]);
  }
  const fam = families[0].sort((a, b) => a.c.id - b.c.id);
  const units = fam[0].units;
  if (units === 'unknown') return mark > 1 ? { kind: 'qty-unknown' } : { kind: 'units-unconfirmed' };
  if (fam.reduce((n, s) => n + s.c.remaining, 0) < units) return tooMany(sized);
  const allocations: Allocation[] = [];
  let left = units;
  for (const s of fam) {
    if (left <= 0) break;
    const take = Math.min(left, s.c.remaining);
    if (take > 0) { allocations.push({ candidate: s.c, quantity: take }); left -= take; }
  }
  return { kind: 'link', candidate: allocations[0].candidate, quantity: allocations[0].quantity, allocations, by: matchedBy };
}

// Every fitting name is too small for the order.
function tooMany(sized: { c: Candidate }[]): MatchOutcome {
  return { kind: 'too-many', candidate: sized.reduce((best, s) => (s.c.remaining > best.c.remaining ? s : best)).c };
}
