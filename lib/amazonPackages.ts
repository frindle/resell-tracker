// Per-package capture from Amazon order detail and tracking pages: which
// tracking number holds which items, and how many of each. Pure DOM work (no
// network, no DB); lib/amazonPageParse.ts calls it and attaches the result to
// ParsedOrder.packages.
//
// UNVERIFIED SELECTORS. This repo holds no saved real Amazon page showing how
// a shipment lists its items and quantities, so every selector below is a
// best guess from the markup the rest of the parser already relies on
// (data-component="itemTitle" etc.) plus Amazon's usual "qty badge only when
// more than 1". Tests use synthetic markup only. Until a real capture proves
// the selectors, anything this module cannot read comes back as
// items: null ("unknown"), never a guess, and quantities that were not shown
// on the page are flagged qtyAssumed so the matcher can say so.

export interface PackageItem {
  title: string;
  asin?: string;
  quantity: number;
  /** true when the page showed no quantity and 1 was assumed (Amazon hides the badge for single units). */
  qtyAssumed?: boolean;
}

export interface ParsedPackage {
  trackingNumber: string;
  carrier?: string;
  /** null = items could not be read for this package (unknown, not "empty"). */
  items: PackageItem[] | null;
  source: 'detail' | 'tracking';
}

export interface PackageHelpers {
  /** Cleaned tracking numbers found inside a root (document or element). */
  trackingIn(root: Document | Element): string[];
}

const squash = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

const SHIPMENT_SEL = '[data-component="shipments"] [data-component="shipment"], [data-component="shipmentCard"], .shipment, [class*="shipment-card"]';
const TITLE_SEL = '[data-component="itemTitle"]';
const FALLBACK_TITLE_SEL = 'a[href*="/dp/"], a[href*="/gp/product/"]';
const QTY_SEL = '.od-item-view-qty, [data-component="quantity"], [class*="item-view-qty"]';

export function carrierOf(tracking: string, text: string): string | undefined {
  const labelled = text.match(/\b(?:Carrier|Shipped with|Delivered by|Shipping carrier)[:\s]+(USPS|UPS|FedEx|DHL|Amazon Logistics|OnTrac|LaserShip)\b/i);
  if (labelled) return labelled[1].replace(/^usps$/i, 'USPS').replace(/^ups$/i, 'UPS');
  if (/^TBA\d+$/i.test(tracking)) return 'Amazon Logistics';
  if (/^1Z[A-Z0-9]{16}$/i.test(tracking)) return 'UPS';
  if (/^9\d{19,21}$/.test(tracking)) return 'USPS';
  return undefined;
}

/** Text of an element with a space between adjacent elements (textContent glues "Name" + "Qty: 2"). */
function spacedText(el: Element): string {
  const parts: string[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === 3) { parts.push(n.nodeValue ?? ''); return; }
    if (n.nodeType !== 1) return;
    const tag = (n as Element).tagName?.toUpperCase();
    if (tag === 'SCRIPT' || tag === 'STYLE') return;
    n.childNodes.forEach(walk);
    parts.push(' ');
  };
  walk(el);
  return squash(parts.join(''));
}

function asinOf(href: string | null | undefined): string | undefined {
  return (href ?? '').match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/)?.[1];
}

function qtyOf(row: Element): { quantity: number; assumed: boolean } {
  for (const el of Array.from(row.querySelectorAll(QTY_SEL))) {
    const m = squash(el.textContent).match(/(\d+)/);
    if (m) return { quantity: parseInt(m[1], 10), assumed: false };
  }
  const m = spacedText(row).match(/\b(?:Qty|Quantity)[:.\s]+(\d+)\b/i);
  if (m) return { quantity: parseInt(m[1], 10), assumed: false };
  return { quantity: 1, assumed: true };
}

/** The smallest ancestor of `title` (below `root`) that holds no other title element. */
function rowFor(title: Element, root: Element | Document, titleSel: string): Element {
  let row: Element = title;
  for (let i = 0; i < 4; i++) {
    const p = row.parentElement;
    if (!p || p === root) break;
    if (p.querySelectorAll(titleSel).length > 1) break;
    row = p;
  }
  return row;
}

/** Items listed under `root`, or null when none could be read. */
export function itemsIn(root: Element | Document): PackageItem[] | null {
  let titles = Array.from(root.querySelectorAll(TITLE_SEL));
  let sel = TITLE_SEL;
  if (!titles.length) { titles = Array.from(root.querySelectorAll(FALLBACK_TITLE_SEL)); sel = FALLBACK_TITLE_SEL; }
  const items: PackageItem[] = [];
  for (const t of titles) {
    const title = squash(t.textContent).slice(0, 160);
    if (title.length < 3) continue; // image-only links, "Buy it again", etc.
    const link = t.tagName === 'A' ? t : t.querySelector('a');
    const row = rowFor(t, root, sel);
    const q = qtyOf(row);
    if (!Number.isInteger(q.quantity) || q.quantity < 1) return null; // unreadable quantity poisons the package
    items.push({ title, asin: asinOf(link?.getAttribute('href')), quantity: q.quantity, ...(q.assumed ? { qtyAssumed: true } : {}) });
  }
  if (!items.length) return null;
  // The same product listed twice (two rows) is summed, not dropped.
  const merged: PackageItem[] = [];
  for (const it of items) {
    const same = merged.find(m => (it.asin && m.asin === it.asin) || (!it.asin && !m.asin && m.title === it.title));
    if (same) { same.quantity += it.quantity; same.qtyAssumed = same.qtyAssumed && it.qtyAssumed ? true : undefined; }
    else merged.push({ ...it });
  }
  return merged;
}

/**
 * Packages on an order detail page. One entry per shipment block that carries
 * exactly one tracking number. A block with several tracking numbers, or a page
 * with no recognisable shipment blocks, yields packages with items: null.
 */
export function packagesFromDetail(doc: Document, h: PackageHelpers): ParsedPackage[] {
  const all = Array.from(doc.querySelectorAll(SHIPMENT_SEL));
  const blocks = all.filter(b => !all.some(o => o !== b && o.contains(b)));
  const out: ParsedPackage[] = [];
  const seen = new Set<string>();
  const push = (p: ParsedPackage) => {
    const prior = out.find(o => o.trackingNumber === p.trackingNumber);
    if (!prior) { out.push(p); seen.add(p.trackingNumber); return; }
    // Same tracking in two blocks: keep one only if both agree, otherwise unknown.
    if (JSON.stringify(prior.items) !== JSON.stringify(p.items)) prior.items = null;
  };
  for (const b of blocks) {
    const nums = h.trackingIn(b);
    if (!nums.length) continue; // not shipped yet
    const text = squash(b.textContent);
    if (nums.length === 1) push({ trackingNumber: nums[0], carrier: carrierOf(nums[0], text), items: itemsIn(b), source: 'detail' });
    else for (const n of nums) push({ trackingNumber: n, carrier: carrierOf(n, text), items: null, source: 'detail' });
  }
  if (!out.length) {
    const text = squash(doc.body?.textContent ?? doc.documentElement?.textContent);
    for (const n of h.trackingIn(doc)) push({ trackingNumber: n, carrier: carrierOf(n, text), items: null, source: 'detail' });
  }
  return out;
}

/** Packages on a tracking page (one shipment). Several tracking numbers on it => items unknown. */
export function packagesFromTracking(doc: Document, h: PackageHelpers): ParsedPackage[] {
  const nums = h.trackingIn(doc);
  if (!nums.length) return [];
  const text = squash(doc.body?.textContent ?? doc.documentElement?.textContent);
  if (nums.length > 1) return nums.map(n => ({ trackingNumber: n, carrier: carrierOf(n, text), items: null, source: 'tracking' as const }));
  return [{ trackingNumber: nums[0], carrier: carrierOf(nums[0], text), items: itemsIn(doc), source: 'tracking' }];
}
