// Which gift card brand a read code belongs to, from the OCR lines of its own
// photo. The brand is never taken from the order or another photo: a person
// confirms it where the photo does not settle it (see cardBrand below).
//
// Pure, no I/O.

import { canonicalGiftBrand } from './giftBrand.ts';

export type Box = [number, number, number, number];
export type BrandLine = { text: string; box?: Box | null };
export type BrandMention = { brand: string; box: Box | null };

export const MERCHANTS: [RegExp, string][] = [
  [/\buber\s*eats\b|\buber\b/i, 'Uber Eats'],
  [/\bdoor\s*dash\b/i, 'DoorDash'],
  [/\bstarbucks\b/i, 'Starbucks'],
  // "Add to Apple Wallet" / "Apple Pay" on an e-gift screen is not the card's brand.
  [/\bapple\b(?!\s*(?:pay|wallet))/i, 'Apple'],
  [/\bamazon\b/i, 'Amazon'],
  [/\bxbox\b/i, 'Xbox'],
  [/\bplaystation\b/i, 'PlayStation'],
  [/\bnintendo\b/i, 'Nintendo'],
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A brand already on a saved card, as whole words ("Best Buy" is not inside "Best Buyer"). */
function knownRe(brand: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9])${escapeRe(brand.trim()).replace(/\s+/g, '\\s+')}(?![A-Za-z0-9])`, 'i');
}

/**
 * Every brand named on a line, each once. A match is dropped only when its span
 * on the line lies inside a longer match's span ("Uber" inside "Uber Eats"), so
 * "Apple and Applebee's" keeps both.
 */
export function brandMentions(lines: readonly BrandLine[], known: readonly string[]): BrandMention[] {
  const knownNames = [...new Set(known.map(k => String(k ?? '').trim()).filter(Boolean))];
  const knownRes = knownNames.map(knownRe);
  const out: BrandMention[] = [];
  for (const line of lines) {
    const text = String(line.text ?? '');
    const found: { name: string; start: number; end: number }[] = [];
    const add = (re: RegExp, name: string) => {
      for (const m of text.matchAll(new RegExp(re.source, 'gi'))) {
        if (m[0].length) found.push({ name, start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
      }
    };
    for (const [re, name] of MERCHANTS) add(re, name);
    knownNames.forEach((k, i) => add(knownRes[i], k));
    const seen = new Map<string, string>();
    for (const f of found) {
      if (found.some(o => o.start <= f.start && f.end <= o.end && o.end - o.start > f.end - f.start)) continue;
      const c = canonicalGiftBrand(f.name);
      if (c && !seen.has(c.toLowerCase())) seen.set(c.toLowerCase(), c);
    }
    for (const b of seen.values()) out.push({ brand: b, box: line.box ?? null });
  }
  return out;
}

const normCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
const centre = (b: Box): [number, number] => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
/** Two boxes cover some of the same area: one printed line read twice, not two lines. */
const overlaps = (a: Box, b: Box) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

/**
 * The line a code is printed on: the first line holding the whole code, else the
 * one line matching its first 8 characters. Sequential card numbers share
 * prefixes, so a prefix match counts only when no other line matches it and the
 * line does not hold another of the photo's codes.
 */
function ownLine(c: string, lines: readonly BrandLine[], allCodes: readonly string[]): BrandLine | null {
  if (!c) return null;
  const whole = lines.find(l => normCode(l.text ?? '').includes(c));
  if (whole) return whole;
  if (c.length < 8) return null;
  const hits = lines.filter(l => normCode(l.text ?? '').includes(c.slice(0, 8)));
  if (hits.length !== 1) return null;
  const t = normCode(hits[0].text ?? '');
  return allCodes.some(o => o !== c && t.includes(o)) ? null : hits[0];
}

export type CardBrand = { brand: string | null; from: 'card' | 'photo' | null; others: string[] };

/**
 * The brand of one read code. First the brand printed nearest the code's own
 * line, unless another brand is almost as near (two packs side by side, or a
 * code between them); else the photo's brand when it names just one and the
 * photo has just one code line; else none, and `others` lists what the photo
 * names so a person can say which.
 *
 * `codes` is every code read on the same photo, this one included. A printed
 * brand belongs to one code only: the nearest code line, looking at the lines
 * level with or below it first (a brand is printed above its code, so a brand
 * between two stacked codes heads the lower one). A tie belongs to neither.
 * Boxes are [x0, y0, x1, y1].
 */
export function cardBrand(
  code: string,
  lines: readonly BrandLine[],
  known: readonly string[],
  codes?: readonly string[],
): CardBrand {
  const mentions = brandMentions(lines, known);
  const distinct = new Map<string, string>();
  for (const m of mentions) if (!distinct.has(m.brand.toLowerCase())) distinct.set(m.brand.toLowerCase(), m.brand);
  const othersOf = (brand: string | null) =>
    [...distinct.entries()].filter(([k]) => k !== brand?.toLowerCase()).map(([, v]) => v).sort();

  const c = normCode(code);
  const all = [...new Set([c, ...(codes ?? []).map(normCode)])].filter(Boolean);
  const own = ownLine(c, lines, all);
  const placed = mentions.filter((m): m is { brand: string; box: Box } => m.box != null);

  if (own?.box && placed.length) {
    const mine = own.box;
    // Other codes' lines; a variant misread on the same line is not another card.
    const theirs: Box[] = [];
    for (const o of all) {
      if (o === c) continue;
      const l = ownLine(o, lines, all);
      if (l?.box && l !== own && !overlaps(l.box, mine)) theirs.push(l.box);
    }
    const dist = (m: { box: Box }, b: Box) => {
      const [x, y] = centre(m.box); const [bx, by] = centre(b);
      return Math.hypot(x - bx, y - by);
    };
    const vouches = (m: { box: Box }) => {
      const slack = (m.box[3] - m.box[1]) / 2;
      const below = [mine, ...theirs].filter(b => centre(b)[1] + slack >= centre(m.box)[1]);
      const pool = below.length ? below : [mine, ...theirs];
      if (!pool.includes(mine)) return false;
      return pool.every(b => b === mine || dist(m, b) > dist(m, mine));
    };
    const owned = placed.filter(vouches);
    if (owned.length) {
      let near = owned[0];
      for (const m of owned) if (dist(m, mine) < dist(near, mine)) near = m;
      const d = dist(near, mine);
      const rival = placed.some(m => m.brand.toLowerCase() !== near.brand.toLowerCase() && dist(m, mine) <= d * 1.5);
      if (!rival) return { brand: near.brand, from: 'card', others: othersOf(near.brand) };
    }
  }

  // The photo's one brand is this code's only when the photo has one code line.
  // Count distinct line boxes, not codes: misreads of one code share a line.
  const boxes: Box[] = [];
  for (const o of all) {
    const b = ownLine(o, lines, all)?.box;
    if (b && !boxes.some(x => overlaps(x, b))) boxes.push(b);
  }
  const oneLine = boxes.length ? boxes.length === 1 && !!own?.box : all.length === 1;
  if (distinct.size === 1 && oneLine) return { brand: [...distinct.values()][0], from: 'photo', others: [] };
  return { brand: null, from: null, others: othersOf(null) };
}
