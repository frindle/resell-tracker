// "Purchase limits that reset today" lines for the Resell section of the daily
// digest (see lib/digestLines.ts).
//
// The digest goes out at about 05:07 LA and covers the day before, so the lines
// for LA day D are read on D+1: the resets listed are the ones that fall on D+1.
//   - Amazon: a product's limit resets 7 days to the minute after the order
//     time (Order.orderedAt).
//   - Walmart: about 2 orders per 24 hours for non-Apple products; each such
//     order frees its slot 24 hours after Order.orderedAt. Apple products have
//     no rule here and are left out.
//   - Costco: gift cards are limited to one per 14 days, counted from the
//     eGift email's delivery time (Order.egiftDeliveredAt), not the order time.
// Orders record no retailer account, so resets are not grouped by account.
//
// Lines carry product names and times only: no order numbers, amounts or
// addresses. A name the queue would refuse (an @, a currency word, a long model
// number) loses that part, never the day.

import { MAX_LINE_CHARS, cutLine, lineLooksPrivate } from './digestPrivate.ts';
import { laMidnight, shiftDay } from './laDay.ts';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** How long after the time we hold does each retailer's limit last. */
export const RESET_AFTER_MS = { Amazon: 7 * DAY_MS, Walmart: 24 * HOUR_MS, Costco: 14 * DAY_MS } as const;

/** Lines the reset lines may use in the whole section (the count lines come first). */
export const RESET_LINE_BUDGET = 5;
// Items are packed to this width, leaving room for " and N more." inside the queue's line limit.
const PACK_CHARS = MAX_LINE_CHARS - 16;

export type ResetItem = { title: string; quantity: number; qtyAssumed?: boolean };

export type ResetOrder = {
  platform: string;
  itemDescription: string | null;
  cancelled: boolean;
  orderedAt: Date | null;
  egiftDeliveredAt: Date | null;
  /** Per-item titles and quantities when known (Amazon package captures); else the description is used. */
  items?: ResetItem[];
};

/**
 * Orders whose limit resets on the LA day after `day`, as the range of the
 * time the reset counts from: [from, to) for each retailer.
 */
export function resetRanges(day: string): Record<'Amazon' | 'Walmart' | 'Costco', { from: Date; to: Date }> {
  const start = laMidnight(shiftDay(day, 1)).getTime();
  const end = laMidnight(shiftDay(day, 2)).getTime();
  const r = (ms: number) => ({ from: new Date(start - ms), to: new Date(end - ms) });
  return { Amazon: r(RESET_AFTER_MS.Amazon), Walmart: r(RESET_AFTER_MS.Walmart), Costco: r(RESET_AFTER_MS.Costco) };
}

const APPLE_RE = /\b(?:apple|iphone|ipad|airpods?|macbook|imac|airtag|mac\s?mini|mac\s?studio|homepod)\b/i;

/** True for an item the Walmart 24-hour rule leaves out (Apple products, by description). */
export function isApple(description: string | null | undefined): boolean {
  return APPLE_RE.test(String(description ?? ''));
}

const laTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit', hour12: true });

/** "3:42 PM" in LA time. */
export function formatResetTime(at: Date): string {
  return laTime.format(at).replace(/\s/g, ' ');
}

/**
 * A short product name: the first few words, cut at about 30 characters, with
 * any word the queue would refuse dropped. `numbers` also drops bare numbers
 * (gift card denominations). '' when nothing is left.
 */
export function shortName(description: string | null | undefined, numbers = false): string {
  const words = String(description ?? '').split(/\s+/)
    .map(w => w.replace(/^[,;:|/()\[\]"'-]+|[,;:|/()\[\]"'-]+$/g, ''))
    .filter(w => w && !lineLooksPrivate(w) && !/[$¢£¥€@]/.test(w) && !(numbers && /^\p{Nd}+$/u.test(w)));
  let out = '';
  for (const w of words.slice(0, 5)) {
    const next = out ? `${out} ${w}` : w;
    if (next.length > 30) break;
    out = next;
  }
  if (!out && words[0]) out = words[0].slice(0, 30);
  return out;
}

type Entry = { name: string; qty: number | null; at: Date };

function entriesFor(o: ResetOrder, at: Date, numbers: boolean, fallback: string): Entry[] {
  const known = (o.items ?? []).filter(i => i.title && i.quantity > 0);
  if (known.length) {
    return known.map(i => ({ name: shortName(i.title, numbers) || fallback, qty: i.qtyAssumed ? null : i.quantity, at }));
  }
  return [{ name: shortName(o.itemDescription, numbers) || fallback, qty: null, at }];
}

/** Products with their reset times, grouped by name and ordered by the first reset. */
function group(entries: Entry[]): { name: string; times: string[] }[] {
  const by = new Map<string, { name: string; first: number; list: Entry[] }>();
  for (const e of entries) {
    const key = e.name.toLowerCase();
    const g = by.get(key) ?? { name: e.name, first: e.at.getTime(), list: [] };
    g.first = Math.min(g.first, e.at.getTime());
    g.list.push(e);
    by.set(key, g);
  }
  return [...by.values()].sort((a, b) => a.first - b.first || a.name.localeCompare(b.name)).map(g => ({
    name: g.name,
    times: g.list.sort((a, b) => a.at.getTime() - b.at.getTime()).map(e => `${formatResetTime(e.at)}${e.qty != null && e.qty > 1 ? ` x${e.qty}` : ''}`),
  }));
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Lines of one retailer: each line holds `units` items (the header line, if any, holds none).
type Block = { lines: { text: string; units: number }[] };

/** Packs `items` into lines no wider than PACK_CHARS: the first starts with `first`, later ones with `rest`. */
function pack(items: string[], first: string, rest: string, sep: string): Block['lines'] {
  const out: Block['lines'] = [];
  let cur = '';
  let units = 0;
  for (const it of items) {
    const prefix = out.length === 0 ? first : rest;
    const next = cur ? `${cur}${sep}${it}` : `${prefix}${it}`;
    if (cur && next.length > PACK_CHARS) {
      out.push({ text: cur, units });
      cur = `${rest}${it}`;
      units = 1;
    } else {
      cur = next;
      units++;
    }
  }
  if (cur) out.push({ text: cur, units });
  return out;
}

// A string the queue would refuse is rewritten to the bare minimum rather than sent.
const safe = (s: string, fallback: string) => (lineLooksPrivate(cutLine(s)) ? fallback : s);

/** The reset lines for LA day `day` (read the morning after), at most `budget` of them. */
export function buildResetLines(day: string, orders: readonly ResetOrder[], budget = RESET_LINE_BUDGET): string[] {
  const ranges = resetRanges(day);
  const inRange = (t: Date | null, r: { from: Date; to: Date }) => !!t && t.getTime() >= r.from.getTime() && t.getTime() < r.to.getTime();
  const live = orders.filter(o => !o.cancelled);

  const amazon: Entry[] = [];
  const walmart: Date[] = [];
  const costco: Entry[] = [];
  for (const o of live) {
    if (o.platform === 'Amazon' && o.orderedAt && inRange(o.orderedAt, ranges.Amazon)) {
      amazon.push(...entriesFor(o, new Date(o.orderedAt.getTime() + RESET_AFTER_MS.Amazon), false, 'item'));
    } else if (o.platform === 'Walmart' && o.orderedAt && inRange(o.orderedAt, ranges.Walmart) && !isApple(o.itemDescription)) {
      walmart.push(new Date(o.orderedAt.getTime() + RESET_AFTER_MS.Walmart));
    } else if (o.platform === 'Costco' && o.egiftDeliveredAt && inRange(o.egiftDeliveredAt, ranges.Costco)) {
      costco.push(...entriesFor({ ...o, items: undefined }, new Date(o.egiftDeliveredAt.getTime() + RESET_AFTER_MS.Costco), true, 'gift card'));
    }
  }

  const blocks: Block[] = [];
  const amazonGroups = group(amazon);
  if (amazonGroups.length) {
    const items = amazonGroups.map(g => safe(`${g.name} ${g.times.join(', ')}`, `item ${g.times.join(', ')}`));
    blocks.push({ lines: [{ text: `Amazon limits reset today: ${plural(amazonGroups.length, 'product')}.`, units: 0 }, ...pack(items, '', '', '; ')] });
  }
  if (walmart.length) {
    const times = walmart.sort((a, b) => a.getTime() - b.getTime()).map(formatResetTime);
    const lines = pack(times, 'Walmart order slots free today: ', 'More Walmart slots: ', ', ');
    lines[lines.length - 1].text += '.';
    blocks.push({ lines });
  }
  const costcoGroups = group(costco);
  if (costcoGroups.length) {
    const items = costcoGroups.map(g => safe(`${g.name} ${g.times.join(', ')}`, `gift card ${g.times.join(', ')}`));
    const orders = costcoGroups.reduce((n, g) => n + g.times.length, 0);
    blocks.push({ lines: [{ text: `Costco gift card limit resets today: ${plural(orders, 'order')}.`, units: 0 }, ...pack(items, '', '', '; ')] });
  }

  // Every retailer with resets gets its first line before any gets a second.
  const keep = blocks.map(() => 0);
  let left = Math.max(0, budget);
  for (let i = 0; i < blocks.length && left > 0; i++, left--) keep[i] = 1;
  for (let progressed = true; left > 0 && progressed;) {
    progressed = false;
    for (let i = 0; i < blocks.length && left > 0; i++) {
      if (keep[i] > 0 && keep[i] < blocks[i].lines.length) { keep[i]++; left--; progressed = true; }
    }
  }

  const out: string[] = [];
  blocks.forEach((b, i) => {
    if (!keep[i]) return;
    const shown = b.lines.slice(0, keep[i]).map(l => l.text);
    const cut = b.lines.slice(keep[i]).reduce((n, l) => n + l.units, 0);
    // A header with nothing under it already says how many; a cut list says how many it left out.
    const hasBody = b.lines.slice(0, keep[i]).some(l => l.units > 0);
    if (cut > 0 && hasBody) shown[shown.length - 1] = `${shown[shown.length - 1].replace(/\.$/, '')} and ${cut} more.`;
    out.push(...shown);
  });
  return out.map(cutLine).filter(l => !lineLooksPrivate(l));
}
