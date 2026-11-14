// Server-side parsing of Amazon order pages captured by the browser
// extension. Ported from sidecar/src/amazon.js (order list scrape, detail
// extract, tracking page, payment-box string helpers) and the extension's
// extractCarrierTracking. Takes a DOM Document (linkedom on the server) and
// never touches the network.
import { taxFields } from './amazonTax.ts';

export type AmazonPageKind = 'orders' | 'detail' | 'tracking';

export interface ParsedOrder {
  orderNumber: string;
  orderDate?: string;          // YYYY-MM-DD
  itemDescription?: string;
  cost?: number;
  taxAmount?: number | null;   // null = page did not show tax
  subtotalAmount?: number | null;
  shippingAddress?: string;
  trackingNumbers: string[];
  paymentLast4?: string;
  paymentRatePercent?: number;
  noRushBonusPercent?: number;
  deliveryPhotoUrl?: string;
  detailUrl?: string;
  trackUrls: string[];
  fromDetail?: boolean;        // true when parsed from the order detail page
}

export interface ParsedPage {
  kind: AmazonPageKind;
  blocked: boolean;
  blockReason?: 'sign-in' | 'captcha' | 'agent-block';
  orders: ParsedOrder[];
  nextUrl?: string | null;
  oldestDate?: string | null;  // oldest order date seen on a list page
  parseFailed?: boolean;
  noTrackingYet?: boolean;     // tracking page for an order that has not shipped
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

export function parseDateText(s: string): string | null {
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const m = s.match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (!m) return null;
  const mon = MONTHS[m[1].toLowerCase()];
  if (!mon) return null;
  return `${m[3]}-${String(mon).padStart(2, '0')}-${String(parseInt(m[2], 10)).padStart(2, '0')}`;
}

function parseMoney(text: string): number {
  return parseFloat(text.replace(/[^0-9.-]/g, '')) || 0;
}
const squash = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

function abs(href: string | null | undefined, base: string): string | null {
  if (!href) return null;
  try { return new URL(href, base).toString(); } catch { return null; }
}

const TRACK_LINK_SEL = 'a[href*="ship-track"], a[href*="progress-tracker"], a[href*="package-tracking"]';
const BAD_TRACK_RE = /\/(preship|cancel-items?|return|refund|replacement)\b/i;

function trackLinks(root: Element | Document, base: string): string[] {
  const out: string[] = [];
  for (const a of Array.from(root.querySelectorAll(TRACK_LINK_SEL))) {
    const h = abs(a.getAttribute('href'), base);
    if (h && !BAD_TRACK_RE.test(h) && !out.includes(h)) out.push(h);
  }
  return out;
}

export function detectBlock(doc: Document): ParsedPage['blockReason'] | undefined {
  const text = squash(doc.documentElement?.textContent);
  if (/unauthorized AI agent violates Amazon'?s Conditions of Use/i.test(text)) return 'agent-block';
  if (doc.querySelector('form[action*="validateCaptcha"], #captchacharacters') || /enter the characters you see|not a robot/i.test(text)) return 'captcha';
  if (doc.querySelector('form[name="signIn"], input#ap_email, input#ap_password, input#ap_email_login, form[action*="/ax/claim"]')
    || /sign in or create account/i.test(text)) return 'sign-in';
  return undefined;
}

// --- carrier tracking (extension's extractCarrierTracking) -----------------

export function extractCarrierTracking(doc: Document): string[] {
  const found: string[] = [];
  const text = squash(doc.body?.textContent ?? doc.documentElement?.textContent);

  const ptCards = Array.from(doc.querySelectorAll('.pt-delivery-card-trackingId, [data-test-id="tracking-id"], [class*="trackingId"]'));
  for (const el of ptCards) {
    const v = (el.textContent ?? '').replace(/Tracking\s*(?:ID|number)?[:\s]*/i, '').trim().split(/\s+/)[0];
    if (v && /^[A-Z0-9]{8,30}$/i.test(v)) found.unshift(v);
  }

  const amzl = text.match(/\bTBA(\d{12,15})(?!\d)/g)?.map(m => m.replace(/\D+$/, ''));
  const ups = text.match(/\b(1Z[A-Z0-9]{16})\b/g);
  const usps = text.match(/\b(9[0-9]{19,21})\b/g);
  const fedex = text.match(/\b([1-8][0-9]{14})\b/g);

  const nearLabel = text.match(/Tracking(?:\s+ID|\s+number)?[:\s]+([A-Z0-9]{10,30})/gi) ?? [];
  for (const m of nearLabel) {
    const val = m.replace(/Tracking(?:\s+ID|\s+number)?[:\s]+/i, '').trim().split(' ')[0];
    // a label followed by the word "tracking" etc. is page chrome, not a number
    if (val && !/track/i.test(val)) found.unshift(val);
  }

  if (amzl) found.push(...amzl);
  if (ups) found.push(...ups);
  if (usps) found.push(...usps);
  if (fedex) found.push(...fedex);

  for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
    const href = a.getAttribute('href') ?? '';
    if (!/usps\.com|ups\.com|fedex\.com|dhl\.com|ontrac\.com|lasership\.com/i.test(href)) continue;
    const m = href.match(/[?&](?:qtc_tLabels1|tLabels|tracknum|InquiryNumber\d*|tracknumbers|trknbr|AWB|tracking[_-]?number[s]?|trackingNumber)=([A-Z0-9]{8,30})/i);
    if (m) found.unshift(m[1]);
  }
  return [...new Set(found)];
}

/** Same cleanup the sidecar applies in fetchOrderDetails: strip trailing letters (not 1Z), drop prefixes, max 5. */
export function cleanTracking(raw: string[]): string[] {
  const cleaned = [...new Set(raw)].map(t => /^1Z/i.test(t) ? t : t.replace(/[A-Za-z]+$/, ''));
  const nonEmpty = [...new Set(cleaned)].filter(t => t && t.length >= 8);
  return nonEmpty.filter(t => !nonEmpty.some(other => other !== t && t.startsWith(other))).slice(0, 5);
}

// --- payment box string helpers (sidecar extractIrisLastDigits etc.) -------

export function paymentEntrySlices(html: string): string[] {
  const entryRe = /<[^>]*\baria-label\s*=\s*(?:"payment method"|'payment method')/gi;
  const starts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(html))) {
    let tagStart = m.index;
    while (tagStart > 0 && html[tagStart] !== '<') tagStart--;
    starts.push(tagStart);
  }
  return starts.map((st, i) => html.slice(st, i + 1 < starts.length ? starts[i + 1] : undefined));
}

export function leafTexts(slice: string): string[] {
  const leaves: string[] = [];
  let pos = 0;
  while (pos < slice.length) {
    const ltIdx = slice.indexOf('<', pos);
    if (ltIdx === -1) break;
    if (ltIdx > pos && slice.slice(pos, ltIdx).trim()) leaves.push(slice.slice(pos, ltIdx).replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
    const gtIdx = slice.indexOf('>', ltIdx);
    if (gtIdx === -1) break;
    pos = gtIdx + 1;
  }
  return leaves;
}

export function extractCardFromPaymentHtml(html: string): { last4: string; brand: string | null } | null {
  if (typeof html !== 'string' || !html.length) return null;
  for (const slice of paymentEntrySlices(html)) {
    const leaves = leafTexts(slice);
    let last4: string | null = null;
    let last4Leaf: string | null = null;
    for (const leaf of leaves) {
      const m2 = leaf.match(/(?<!\d)\d{4}(?!\d)/);
      if (m2) { last4 = m2[0]; last4Leaf = leaf; break; }
    }
    if (!last4 || !last4Leaf) continue;
    let brand = last4Leaf
      .replace(/(?<!\d)\d{4}(?!\d)/, '')
      .replace(/[•·․⋅●*]+|\bending(?:\s+in)?\b|\bx{4,}\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!brand) brand = leaves.find(l => !/\d/.test(l) && !/terms|conditions|learn more|details/i.test(l)) || '';
    return { last4, brand: brand || null };
  }
  return null;
}

/** Total cashback % from a payment entry's "Earns|Get X% back and extra Y% ..." text, else null. */
export function paymentRateFromHtml(html: string): number | null {
  if (typeof html !== 'string' || !html.length) return null;
  const slices = paymentEntrySlices(html);
  const text = (slices.length ? slices : [html]).map(sl => leafTexts(sl).join(' ')).join(' ');
  const m = text.match(/(?:Earns|Get)\s+(\d+(?:\.\d+)?)\s*%\s*back/i);
  if (!m) return null;
  let rate = parseFloat(m[1]);
  for (const x of text.slice(m.index).matchAll(/\bextra\s+(\d+(?:\.\d+)?)\s*%/gi)) rate += parseFloat(x[1]);
  return Math.round(rate * 100) / 100;
}

const LAST4_PATTERNS = [
  /\bending\s+in\s+(\d{4})\b/i, /\bending\s+(\d{4})\b/i,
  /\*{2,}\s*(\d{4})\b/, /\bx{4,}\s*(\d{4})\b/i, /[•·․⋅●]{2,}\s*(\d{4})\b/,
];
function firstLast4(text: string): string | undefined {
  for (const pat of LAST4_PATTERNS) { const m = text.match(pat); if (m) return m[1]; }
  return undefined;
}

// --- order list ------------------------------------------------------------

const TITLE_SEL = '.yohtmlc-product-title a,.yo-enhanced-title a,.item-box a[href*="/dp/"],[class*="product-title"],[class*="item-title"],[class*="yohtmlc-item"],.yo-enhanced-title a,[class*="a-link-normal"][href*="/dp/"],[data-component*="item"] a,a[href*="/dp/"],a[href*="/gp/product/"]';

function parseOrderList(doc: Document, url: string): ParsedPage {
  const orders: ParsedOrder[] = [];
  const seen = new Set<string>();
  let oldest: string | null = null;
  const links = Array.from(doc.querySelectorAll('a[href*="orderID="], a[href*="orderId="], a[href*="order-details"]'));

  for (const link of links) {
    const href = abs(link.getAttribute('href'), url) ?? '';
    const idMatch = href.match(/[oO]rder[Ii][Dd]=([0-9A-Z-]{10,})/);
    if (!idMatch) continue;
    const orderId = idMatch[1];
    if (seen.has(orderId)) continue;
    seen.add(orderId);

    let card: Element | null = link.closest('div.order-card.js-order-card, .js-order-card, .order-card, li.order-card__list');
    if (!card) {
      let cur: Element | null = link;
      for (let i = 0; i < 20; i++) {
        cur = cur?.parentElement ?? null;
        if (!cur) break;
        const t = squash(cur.textContent);
        if (t.length > 100 && /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(t)) { card = cur; break; }
      }
    }
    if (!card) continue;
    const cardText = squash(card.textContent);

    const dateMatch = cardText.match(/Order placed\s+((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})/i)
      ?? cardText.match(/((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})/i)
      ?? cardText.match(/((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+\d{1,2},?\s+\d{4})/i);
    if (!dateMatch) continue;
    const orderDate = parseDateText(dateMatch[1]);
    if (!orderDate) continue;
    if (!oldest || orderDate < oldest) oldest = orderDate;

    const titleEl = card.querySelector(TITLE_SEL);
    const titleText = squash(titleEl?.textContent);
    const statusText = titleText ? cardText.split(titleText).join(' ') : cardText;
    if (/\b(cancelled|canceled|refunded|returned)\b/i.test(statusText)) continue;

    // Header fields are read by LABEL, never by column position: cancelled
    // cards render a 4-column header with no Total / Ship To.
    const totalMatch = cardText.match(/\bTotal\s*\$\s*([\d,]+\.\d{2})/i);
    const cost: number | undefined = totalMatch ? parseMoney(totalMatch[1]) : undefined;

    const hasApplyNow = /\bApply\s+now\b/i.test(cardText);
    const promoPhrase = /\b(?:Earn\s+(?:up\s+to\s+)?\d+%|Get\s+the\s+Amazon\s+(?:Business\s+)?(?:Prime\s+)?Visa|Get\s+a\s+\$?\d+\s+Amazon\.com\s+(?:Gift\s+Card|Credit)|No\s+annual\s+fee|Card\s+Member)\b/i.test(cardText);
    if (hasApplyNow || (!cost && promoPhrase)) continue;
    if (/\b(?:Ready\s+for\s+pickup|Pick\s+up\s+at|Amazon\s+Locker|Fresh\s+Pickup|Store\s+Pickup|Whole\s+Foods\s+Market\b)/i.test(cardText)) continue;

    let shippingAddress = '';
    const shipNode = card.querySelector('[id^="shipToInsertionNode-shippingAddress-"], .a-popover-preload');
    const shipNodeText = squash(shipNode?.textContent);
    const addrMatch = cardText.match(/Ship to\s+([\s\S]+?)\s+United States/i);
    if (!addrMatch && shipNodeText) {
      const d = shipNodeText.search(/\d/);
      shippingAddress = (d > 0 ? shipNodeText.slice(d) : shipNodeText).replace(/\s*United States\s*$/i, '');
    } else if (addrMatch) {
      const full = addrMatch[1].replace(/\s+/g, ' ').trim();
      const digitIdx = full.search(/\d/);
      shippingAddress = digitIdx > 0 ? full.slice(digitIdx) : full;
    }

    let itemDescription = titleText.slice(0, 120);
    if (!itemDescription) itemDescription = squash(card.querySelector('a[href*="/dp/"], a[href*="/gp/product/"]')?.textContent).slice(0, 120);

    orders.push({
      orderNumber: orderId,
      orderDate,
      itemDescription: itemDescription || undefined,
      cost,
      shippingAddress: shippingAddress || undefined,
      paymentLast4: firstLast4(cardText),
      trackingNumbers: [],
      detailUrl: `https://www.amazon.com/gp/your-account/order-details?orderID=${orderId}`,
      trackUrls: trackLinks(card, url),
    });
  }

  let nextUrl: string | null = null;
  const nextEl = doc.querySelector('.a-pagination .a-last:not(.a-disabled) a, [aria-label="Next page"] a');
  nextUrl = abs(nextEl?.getAttribute('href'), url);
  if (nextUrl && !/^https:\/\/www\.amazon\.com\//.test(nextUrl)) nextUrl = null;

  return { kind: 'orders', blocked: false, orders, nextUrl, oldestDate: oldest };
}

// --- order detail ----------------------------------------------------------

function orderIdFromUrl(url: string): string | null {
  const m = url.match(/[oO]rder[Ii][Dd]=([0-9A-Z-]{10,})/);
  return m ? m[1] : null;
}

function parseOrderDetail(doc: Document, url: string): ParsedPage {
  const html = doc.documentElement?.outerHTML ?? '';
  const orderNumber = orderIdFromUrl(url);
  const notFound = /We can't find an order with that number|Looking for an order|Page Not Found/i.test(html)
    || !/order-details|order-summary|orderDetails|pmts-payments/i.test(html);
  if (!orderNumber || notFound) return { kind: 'detail', blocked: false, orders: [], parseFailed: true };

  let title = '';
  for (const sel of ['[data-component="itemTitle"] a', '.yohtmlc-item a.a-link-normal', '.yohtmlc-product-title a', '.yo-enhanced-title a', '.a-link-normal[href*="/dp/"]', '.a-link-normal[href*="/gp/product/"]']) {
    const t = squash(doc.querySelector(sel)?.textContent);
    if (t.length > 5) { title = t.slice(0, 120); break; }
  }
  if (!title) {
    for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
      if (!/\/dp\/[A-Z0-9]{10}|\/gp\/product\/[A-Z0-9]{10}/.test(a.getAttribute('href') ?? '')) continue;
      const t = squash(a.textContent);
      if (t.length > 5) { title = t.slice(0, 120); break; }
    }
  }

  let address = '';
  for (const h of Array.from(doc.querySelectorAll('h5'))) {
    if (!/ship\s+to/i.test(h.textContent ?? '')) continue;
    const ul = h.nextElementSibling;
    if (!ul || ul.tagName !== 'UL') continue;
    const items = Array.from(ul.querySelectorAll('li span.a-list-item'))
      .map(el => (el.innerHTML ?? '').replace(/<br\s*\/?>/gi, ', ').replace(/<[^>]+>/g, '').trim().replace(/\s+/g, ' '))
      .filter(t => t && !/^united states$/i.test(t));
    const addrItems = items.slice(1);
    if (addrItems.length > 0) { address = addrItems.join(', ').slice(0, 200); break; }
  }

  const bodyText = squash(doc.body?.textContent ?? doc.documentElement?.textContent);
  const chargeText = squash(doc.querySelector('[data-component="chargeSummary"]')?.textContent);
  if (!address) {
    const a = doc.querySelector('[data-component="shippingAddress"]');
    if (a) {
      const lines = (a.innerHTML ?? '').replace(/<br\s*\/?>|<\/(?:div|li|p|span)>/gi, '\n').replace(/<[^>]+>/g, '').split('\n').map(x => squash(x)).filter(x => x && !/^(ship(ping)? (to|address))$/i.test(x) && !/^united states$/i.test(x));
      const addrLines = lines.length > 1 ? lines.slice(1) : lines;
      if (addrLines.length) address = addrLines.join(', ').slice(0, 200);
    }
  }
  let cost = 0;
  const totalMatch = chargeText.match(/Grand Total[:\s]+\$?([\d,]+\.\d{2})/i) ?? bodyText.match(/(?:Order Total|Grand Total)[:\s]+\$?([\d,]+\.?\d*)/i) ?? bodyText.match(/\bTotal[:\s]+\$?([\d,]+\.?\d*)/i);
  if (totalMatch) cost = parseMoney(totalMatch[1]);
  const taxMatch = (chargeText || bodyText).match(/Estimated tax to be collected[:\s]+\$?([\d,]+\.?\d*)/i);
  const taxAmount = taxMatch ? parseMoney(taxMatch[1]) : null;

  const candidates: string[] = [];
  for (const pat of [/"orderDate"\s*:\s*"([^"]+)"/i, /"orderPlacedDate"\s*:\s*"([^"]+)"/i, /"placedDate"\s*:\s*"([^"]+)"/i, /"creationDate"\s*:\s*"([^"]+)"/i]) {
    const m = html.match(pat);
    if (m) candidates.push(m[1]);
  }
  const odText = squash(doc.querySelector('[data-component="orderDate"]')?.textContent);
  if (odText) candidates.unshift(odText);
  doc.querySelectorAll('[data-order-date], [data-order-placed-date], [data-order-timestamp]').forEach(el => {
    for (const attr of ['data-order-date', 'data-order-placed-date', 'data-order-timestamp']) {
      const v = el.getAttribute(attr);
      if (v) candidates.push(v);
    }
  });
  const textMatch = html.match(/Order placed[:\s]+((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})/i);
  if (textMatch) candidates.push(textMatch[1]);
  let orderDate: string | undefined;
  for (const c of candidates) { const d = parseDateText(c); if (d) { orderDate = d; break; } }

  let noRushBonusPercent: number | undefined;
  const noRush = html.match(/(?:extra|additional)\s+(\d+(?:\.\d+)?)\s*%[^<]{0,80}No[- ]?Rush/i);
  if (noRush) noRushBonusPercent = parseFloat(noRush[1]);

  const allBoxes = Array.from(doc.querySelectorAll('[data-component="aapiPaymentMethods"], [class*="paystationpaymentmethod"], [aria-label="payment method"]'));
  // drop boxes nested inside another matched box so a payment entry is never counted twice
  const boxes = allBoxes.filter(b => !allBoxes.some(o => o !== b && o.contains(b)));
  const scoped = boxes.length > 0;
  const boxHtml = boxes.map(el => el.outerHTML).join(' ');
  let paymentLast4: string | undefined;
  let paymentRatePercent: number | undefined;
  if (scoped) {
    paymentLast4 = extractCardFromPaymentHtml(boxHtml)?.last4 ?? firstLast4(boxHtml);
    const r = paymentRateFromHtml(boxHtml);
    if (r != null) paymentRatePercent = r;
    else {
      const rateMatch = boxHtml.match(/(?:Earns|Get)\s+(\d+(?:\.\d+)?)\s*%\s*back/i);
      if (rateMatch) {
        paymentRatePercent = parseFloat(rateMatch[1]);
        for (const m of boxHtml.matchAll(/extra\s+(\d+(?:\.\d+)?)\s*%/gi)) paymentRatePercent += parseFloat(m[1]);
      }
    }
  }
  // Without a payment box the whole-page last4 can be a decoy (gift card, promo): not used.

  const trackUrls = trackLinks(doc, url);
  const tracking = cleanTracking(extractCarrierTracking(doc));
  const tax = taxFields(cost, taxAmount);

  return {
    kind: 'detail', blocked: false,
    orders: [{
      orderNumber, orderDate,
      itemDescription: title || undefined,
      cost: cost || undefined,
      taxAmount: tax.taxAmount ?? null,
      subtotalAmount: tax.subtotalAmount ?? null,
      shippingAddress: address || undefined,
      trackingNumbers: tracking,
      paymentLast4, paymentRatePercent, noRushBonusPercent,
      trackUrls, fromDetail: true,
      detailUrl: url,
    }],
  };
}

// --- tracking page ---------------------------------------------------------

function parseTrackingPage(doc: Document, url: string): ParsedPage {
  const orderNumber = orderIdFromUrl(url);
  doc.querySelectorAll('nav, footer, #navbar, #navFooter, #rhf').forEach(el => el.remove());
  const tracking = cleanTracking(extractCarrierTracking(doc));
  const photoImg = doc.querySelector('img.photo-on-delivery-img-thumb, img[class*="photo-on-delivery"]');
  const candidate = photoImg?.getAttribute('data-src') || photoImg?.getAttribute('src') || '';
  const deliveryPhotoUrl = /^https?:\/\//i.test(candidate) ? candidate : undefined;
  const status = squash(doc.querySelector('.pt-status-main-status')?.textContent);
  // An unshipped order's tracker page has no tracking ID ("Ordered"): that is "no tracking yet", not a parse failure.
  if (!tracking.length && !deliveryPhotoUrl && /^(ordered|preparing|not yet shipped)/i.test(status)) return { kind: 'tracking', blocked: false, orders: [], noTrackingYet: true };
  if (!orderNumber || (!tracking.length && !deliveryPhotoUrl)) return { kind: 'tracking', blocked: false, orders: [], parseFailed: !tracking.length };
  return { kind: 'tracking', blocked: false, orders: [{ orderNumber, trackingNumbers: tracking, deliveryPhotoUrl, trackUrls: [] }] };
}

export function parseAmazonPage(doc: Document, kind: AmazonPageKind, url: string): ParsedPage {
  const block = detectBlock(doc);
  if (block) return { kind, blocked: true, blockReason: block, orders: [] };
  if (kind === 'orders') {
    const p = parseOrderList(doc, url);
    // a list page that rendered no order links is not an empty account: flag it for debugging
    if (!p.orders.length && !/You have not placed any orders|haven't placed (?:any|an) orders?/i.test(squash(doc.documentElement?.textContent))) p.parseFailed = true;
    return p;
  }
  if (kind === 'detail') return parseOrderDetail(doc, url);
  return parseTrackingPage(doc, url);
}
