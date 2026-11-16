// Order-email parsing and routing for the shared order inbox. Pure, no I/O:
// lib/emailSync.ts fetches the messages and calls these.
//
// One inbox takes order mail for every tracker user, two ways:
//   - sent straight to it, or to an alias that forwards to it (To/Delivered-To
//     names the alias), or
//   - forwarded by hand from a user's own mailbox (the forwarder is the outer
//     From, and the retailer's message sits under a "Forwarded message" block).
// Each user lists their addresses in Import › Email Routing; routeEmail picks
// the user whose address the mail was sent to or forwarded from.

export type EmailPlatform = 'Amazon' | 'Walmart' | 'BuyingGroup' | 'Costco' | 'Lenovo' | 'Unknown';
export type EmailKind = 'ordered' | 'shipped' | 'delivered' | 'cancelled' | 'refund' | 'other';

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

const ADDRESS_RE = /[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/** Every email address in `s`, lower case, each once, in order. */
export function emailAddresses(s: string | null | undefined): string[] {
  const out: string[] = [];
  for (const m of String(s ?? '').matchAll(ADDRESS_RE)) {
    const a = m[0].toLowerCase().replace(/^[.'-]+|[.'-]+$/g, '');
    if (a && !out.includes(a)) out.push(a);
  }
  return out;
}

// addy.io rewrites a sender as a reverse alias, alias+local=domain@alias-domain.
const REVERSE_ALIAS_RE = /\b[a-z0-9._%-]+\+([a-z0-9._%+-]+)=([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/gi;

/** `s` with each addy.io reverse alias replaced by the real sender's address. */
export function unwrapReverseAlias(s: string): string {
  return String(s ?? '').replace(REVERSE_ALIAS_RE, '$1@$2');
}

// ---------------------------------------------------------------------------
// Forwarded messages
// ---------------------------------------------------------------------------

export type ForwardedPart = {
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
};

const FWD_SUBJECT_RE = /^\s*(?:(?:fwd?|fw)\s*:\s*)+/i;

/** Subject without any leading Fwd:/Fw:/FW: prefixes. */
export function stripFwdPrefix(subject: string): string {
  return String(subject ?? '').replace(FWD_SUBJECT_RE, '').trim();
}

// Lines that start a forwarded block in the common mail clients.
const FWD_MARKERS = [
  /^-{2,}\s*Forwarded message\s*-{2,}\s*$/i, // Gmail
  /^Begin forwarded message:\s*$/i, // Apple Mail
  /^-{2,}\s*Original Message\s*-{2,}\s*$/i, // Outlook (older), Thunderbird
  /^={2,}\s*Forwarded message\s*={2,}\s*$/i,
  /^_{10,}\s*$/, // Outlook: a rule of underscores above the header block
];

const HEADER_LINE_RE = /^\s*[*>]*\s*(From|Date|Sent|Subject|To|Cc|Reply-To)\s*[*]*\s*:\s*[*]*\s*(.*)$/i;

function parseHeaderBlock(lines: string[], start: number): { headers: Record<string, string>; end: number } | null {
  let i = start;
  while (i < lines.length && lines[i].trim() === '') i++;
  const headers: Record<string, string> = {};
  let n = 0;
  for (; i < lines.length; i++) {
    const m = lines[i].match(HEADER_LINE_RE);
    if (!m) break;
    const key = m[1].toLowerCase() === 'sent' ? 'date' : m[1].toLowerCase();
    if (!(key in headers)) headers[key] = m[2].trim();
    n++;
  }
  // A real header block names who sent it and at least one other field.
  if (!headers.from || n < 2) return null;
  return { headers, end: i };
}

/**
 * The retailer's message inside a forward, or null when `text` is not a
 * forward. Looks for a client's forward marker first; failing that, a message
 * whose subject starts with Fwd:/Fw: and whose text has a From:/Subject:
 * header block.
 */
export function unwrapForwarded(text: string, subject: string): ForwardedPart | null {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const take = (start: number) => {
    const block = parseHeaderBlock(lines, start);
    if (!block) return null;
    const h = block.headers;
    return {
      from: h.from ?? '',
      to: [h.to, h.cc].filter(Boolean).join(', '),
      subject: stripFwdPrefix(h.subject ?? ''),
      date: h.date ?? '',
      body: lines.slice(block.end).join('\n').trim(),
    };
  };
  for (let i = 0; i < lines.length; i++) {
    if (FWD_MARKERS.some(re => re.test(lines[i].trim()))) {
      const part = take(i + 1);
      if (part) return part;
    }
  }
  if (FWD_SUBJECT_RE.test(subject ?? '')) {
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*[*>]*\s*From\s*[*]*\s*:/i.test(lines[i])) {
        // Some clients (Tuta) put Date: above From:, with no marker line.
        let start = i;
        while (start > 0 && HEADER_LINE_RE.test(lines[start - 1])) start--;
        const part = take(start);
        if (part) return part;
      }
    }
  }
  return null;
}

/**
 * A forwarded header block's date: RFC 2822, "Nov 13, 2026, 22:30" (Tuta) or
 * "Sat, Nov 13, 2026 at 10:30 PM" (Gmail). With no zone it is read as the
 * server's local time. Null when it does not parse.
 */
export function parseHeaderDate(s: string): Date | null {
  const t = String(s ?? '')
    .replace(/\s+at\s+(?=\d)/i, ' ')
    .replace(/(\d)(?:st|nd|rd|th)\b/gi, '$1')
    .replace(/(\d{4}),\s*(?=\d{1,2}:\d{2})/, '$1 ')
    .trim();
  if (!t) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}

// addy.io's banner at the top of mail it forwards: "To: alias (Created ...)",
// "From: sender", "Actions: Deactivate | Block email | Block domain", and
// sometimes "Removed N tracking pixels".
const ADDY_ACTIONS_RE = /^\s*Actions:\s*Deactivate\b/i;
const ADDY_PIXELS_RE = /^\s*Removed \d+ tracking pixels?\b/i;

function stripAddyBanner(body: string): string {
  const lines = body.split('\n');
  const actions = lines.slice(0, 10).findIndex(l => ADDY_ACTIONS_RE.test(l));
  if (actions < 0) return body;
  let i = actions + 1;
  while (i < lines.length && (lines[i].trim() === '' || ADDY_PIXELS_RE.test(lines[i]))) i++;
  return lines.slice(i).join('\n').trim();
}

// ---------------------------------------------------------------------------
// What the email is about
// ---------------------------------------------------------------------------

export function detectPlatform(from: string, subject: string): EmailPlatform {
  const f = String(from ?? '').toLowerCase();
  const s = String(subject ?? '').toLowerCase();
  if (f.includes('amazon') || s.includes('amazon')) return 'Amazon';
  if (f.includes('walmart') || s.includes('walmart')) return 'Walmart';
  if (f.includes('buyinggroup') || f.includes('buying group') || s.includes('buying group')) return 'BuyingGroup';
  if (f.includes('costco') || s.includes('costco')) return 'Costco';
  if (f.includes('lenovo')) return 'Lenovo';
  return 'Unknown';
}

/** What happened to the order, from the subject. Most specific first. */
export function emailKind(subject: string): EmailKind {
  const s = stripFwdPrefix(subject).toLowerCase();
  if (/\bcancel/.test(s)) return 'cancelled';
  if (/\brefund|\breturn/.test(s)) return 'refund';
  if (/\bdelivered\b/.test(s)) return 'delivered';
  if (/\bshipped\b|\bon (?:its|the) way\b|\bout for delivery\b|\bshipment\b|\bhas shipped\b|\barriving\b/.test(s)) return 'shipped';
  // Costco's "Manage Your Order" is a gift-delivery notice with no figures.
  if (/\bmanage your order\b/.test(s)) return 'other';
  if (/\bordered\b|\border confirm|\bthanks for your order|\bthank you for your order|\byour order\b|\border (?:placed|received)\b|\byour .*order\b/.test(s)) return 'ordered';
  return 'other';
}

/**
 * Item title from the subject: quoted, e.g. Ordered: "Echo Dot" and 2 more
 * items, or Amazon's newer Ordered 3 items: Laptops.
 */
export function itemFromSubject(subject: string): string {
  const s = stripFwdPrefix(subject);
  const m = s.match(/["“]([^"”]{2,})["”]/);
  if (!m) {
    const n = s.match(/^ordered:?\s*(\d+)\s+items?\s*:\s*(.+)$/i);
    return n ? `${n[2].trim()} (${n[1]} items)` : '';
  }
  const title = m[1].trim().replace(/\.{3}$|…$/, '').trim();
  const more = s.slice((m.index ?? 0) + m[0].length).match(/and\s+(\d+)\s+more\s+items?/i);
  return more ? `${title} (+${more[1]} more)` : title;
}

/**
 * Item names from the body's order table, for retailers whose subject names
 * no item. Lenovo lists rows under an ITEM ... TOTAL PRICE header: name, part
 * number, delivery line, quantity, price. Costco lists each item as: name,
 * "Item", item number, "Price", price, "Quantity", quantity.
 */
export function itemFromBody(platform: EmailPlatform, body: string): string {
  if (platform !== 'Lenovo' && platform !== 'Costco') return '';
  // Soft hyphens and zero-width marks pad Costco's figures (and Amazon's preheader).
  const lines = String(body ?? '').replace(/[­͏​-‏‪-‮⁠﻿]/g, '')
    .split('\n').map(l => l.trim()).filter(Boolean);
  if (platform === 'Costco') return summarizeItems(costcoItems(lines));
  const head = lines.findIndex(l => /(?:^|\s)total price$/i.test(l));
  if (head < 0) return '';
  const items: { name: string; qty: number }[] = [];
  let name = '';
  let qty = 1;
  for (const l of lines.slice(head + 1)) {
    if (/^(?:billing|shipping|payment) details:?$|^sub ?total:?$/i.test(l)) break;
    if (!name) { name = l; qty = 1; continue; }
    if (/^\d{1,3}$/.test(l)) { qty = parseInt(l, 10); continue; }
    if (/^\$[\d,]+\.\d{2}$/.test(l)) { items.push({ name, qty }); name = ''; }
  }
  return summarizeItems(items);
}

function costcoItems(lines: readonly string[]): { name: string; qty: number }[] {
  const items: { name: string; qty: number }[] = [];
  for (let i = 1; i + 1 < lines.length; i++) {
    if (!/^item$/i.test(lines[i]) || !/^\d{5,}$/.test(lines[i + 1])) continue;
    let qty = 1;
    for (let j = i + 2; j + 1 < Math.min(lines.length, i + 8); j++) {
      if (/^quantity$/i.test(lines[j]) && /^\d{1,3}$/.test(lines[j + 1])) { qty = parseInt(lines[j + 1], 10); break; }
    }
    items.push({ name: lines[i - 1], qty });
  }
  return items;
}

function summarizeItems(items: readonly { name: string; qty: number }[]): string {
  if (!items.length) return '';
  const [first] = items;
  return `${first.name}${first.qty > 1 ? ` (x${first.qty})` : ''}${items.length > 1 ? ` (+${items.length - 1} more)` : ''}`;
}

const ORDER_PATTERNS: RegExp[] = [
  // Amazon: 123-1234567-1234567
  /\b(\d{3}-\d{7}-\d{7})\b/,
  // Walmart and others: 10+ digits after # or "order"
  /(?:#|order\s*(?:number|#|no\.?)?[\s:]*)(\d{10,})/i,
  // Generic: "order number ABC123" — must contain a digit
  /order\s*(?:id|number|#|no\.?)[\s:#]*([A-Z0-9-]*\d[A-Z0-9-]{5,})/i,
  // Lenovo: "Your order K000000001 is arriving soon"
  /\b[Oo]rder\s+([A-Z]{1,3}\d{7,})\b/,
];

export function extractOrderNumber(text: string): string {
  for (const re of ORDER_PATTERNS) {
    const m = String(text ?? '').match(re);
    if (m) return m[1];
  }
  return '';
}

const money = (s: string) => parseFloat(s.replace(/,/g, ''));

/**
 * The order's total charge. Labelled totals first (grand, then order, then a
 * bare "Total" that is not a subtotal). Only an order email falls back to the
 * first dollar figure, since shipping and delivery notes rarely carry a total.
 */
export function extractCost(text: string, kind: EmailKind): number {
  const t = String(text ?? '');
  const labelled = [
    /grand\s+total[^\d$]{0,40}\$\s*([\d,]+\.\d{2})/i,
    /order\s+total[^\d$]{0,40}\$\s*([\d,]+\.\d{2})/i,
    /(?<![a-z])(?<!sub[\s-]*)total(?:\s+charged|\s+amount)?[^\d$a-z]{0,40}\$\s*([\d,]+\.\d{2})/i,
    /amount\s+charged[^\d$]{0,40}\$\s*([\d,]+\.\d{2})/i,
  ];
  for (const re of labelled) {
    const m = t.match(re);
    if (m) return money(m[1]);
  }
  if (kind === 'ordered') {
    const m = t.match(/\$\s*([\d,]+\.\d{2})/);
    if (m) return money(m[1]);
  }
  return 0;
}

/** Address block after "Ship to" / "Shipping to" / "Delivered to", one line per comma. */
// A line that starts the next part of the email, not more of the address.
const NOT_ADDRESS_LINE = /^(order|item|qty|quantity|total|subtotal|grand|payment|paid|arriving|estimated|delivery|deliver|ship|view|manage|track|return|sold by|seller|price|tax|\$)/i;

// Amazon's newer order email has no label, just "Name - City, ST" above "Order #".
const AMAZON_SHORT_ADDRESS_RE = /^[ \t]*([^\n]{1,60}?\s-\s[^,\n]{2,40},\s*[A-Z]{2})[ \t]*\n+[ \t]*[Oo]rder\s*#/m;

// Walmart's order email has no label either: one line, "street, [unit,] city, ST, ZIP, USA".
// It must start with a house number and end with a state and ZIP.
const ONE_LINE_ADDRESS_RE = /^[ \t>]*(\d[^\n,]{3,60}(?:,[^\n,]{1,40}){1,3},[ \t]*[A-Z]{2},?[ \t]*\d{5}(?:-\d{4})?(?:,[ \t]*USA)?)[ \t]*$/m;

export function extractShippingAddress(text: string): string {
  const t = String(text ?? '');
  // A label in a sentence ("ship to"), or a heading on its own line (Lenovo's "Shipping Details:").
  const m = /(?:\bship(?:ping|ped)?\s+to\b|\bdeliver(?:y|ed|ing)\s+to\b)\s*:?[ \t]*/i.exec(t)
    ?? /^[ \t]*shipping\s+(?:details|address)[ \t]*:?[ \t]*$/im.exec(t);
  if (!m) return (t.match(AMAZON_SHORT_ADDRESS_RE) ?? t.match(ONE_LINE_ADDRESS_RE))?.[1].trim() ?? '';
  const lines = t.slice(m.index + m[0].length).split('\n').map(l => l.trim());
  const out: string[] = [];
  for (let i = 0; i < lines.length && out.length < 4; i++) {
    const l = lines[i];
    if (!l) {
      // HTML mail converted to text puts blank lines between the address
      // lines; two in a row, or one before anything was read past the
      // label line, still count as the same block.
      if (out.length && !lines[i + 1]) break;
      continue;
    }
    if (out.length && (NOT_ADDRESS_LINE.test(l) || l.endsWith(':'))) break;
    if (l.length < 3) break;
    out.push(l);
    if (/\b\d{5}(?:-\d{4})?\b/.test(l)) break; // ZIP ends the address
  }
  return out.join(', ');
}

// Carrier numbers the import route treats as real tracking (see isRealTracking
// in app/api/import/route.ts). Bare 12–15 digit FedEx numbers are left out:
// too many order and phone numbers look the same.
const TRACKING_RES = [/\bTBA\d{10,}\b/g, /\b1Z[A-Z0-9]{16}\b/g, /\b9\d{19,21}\b/g];

export function extractTrackingNumbers(text: string): string[] {
  const out: string[] = [];
  const t = String(text ?? '').toUpperCase();
  for (const re of TRACKING_RES) {
    for (const m of t.matchAll(re)) if (!out.includes(m[0])) out.push(m[0]);
  }
  return out;
}

// Fields some retailers only put in links: Lenovo's shipping email names its
// order only in the AfterShip "order-number=" link, and carrier links carry
// the tracking number. Long values (Lenovo's encrypted orderNumber=) are not
// order numbers.
const URL_RE = /https?:\/\/[^\s"'<>)\]]+/gi;
const ORDER_PARAM_RE = /[?&](?:order[-_]?(?:number|num|no|id))=([A-Za-z0-9-]{6,24})(?:&|#|$)/i;
const CARRIER_LINK_RE = /track|\bups\b|ups\.com|fedex|usps|dhl|ontrac|lasership/i;

function linkUrls(text: string): string[] {
  const out: string[] = [];
  for (const m of String(text ?? '').matchAll(URL_RE)) {
    let u = m[0].replace(/&amp;/g, '&');
    try { u = decodeURIComponent(u); } catch { /* keep as written */ }
    out.push(u);
  }
  return out;
}

export function orderNumberFromLinks(text: string): string {
  for (const u of linkUrls(text)) {
    const m = u.match(ORDER_PARAM_RE);
    if (m && /\d/.test(m[1]) && !/^[0-9a-f]{16,}$/i.test(m[1])) return m[1];
  }
  return '';
}

export function trackingFromLinks(text: string): string[] {
  const out: string[] = [];
  for (const u of linkUrls(text)) {
    if (!CARRIER_LINK_RE.test(u)) continue;
    for (const t of extractTrackingNumbers(u)) if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** Kinds whose tracking numbers are the order's own shipment (a refund's are a return label). */
export function carriesOrderTracking(kind: EmailKind): boolean {
  return kind !== 'cancelled' && kind !== 'refund';
}

/** What a cancellation email says it cancelled. */
export type CancelInfo = {
  /** The amount released, refunded or not charged; 0 when the email gives none. */
  amount: number;
  /** The email says the whole order was cancelled (and nothing about only some items). */
  whole: boolean;
};

const WHOLE_CANCEL_RE = /\b(?:your|the|this) (?:entire |whole )?order (?:has been|was|is|has) (?:been )?cancel+ed\b|\bcancel+ed your (?:entire |whole )?order\b|\border cancel+ation confirmed\b/i;
const PARTIAL_CANCEL_RE = /\bsome (?:of (?:your|the) )?items?\b|\bone or more items?\b|\bpartial(?:ly)?\b|\bremaining items?\b|\bstill (?:be )?(?:ship|arriv)/i;
const RELEASED_RE = /(?:hold\s+released|released\s+the\s+(?:temporary\s+)?hold|refund(?:ed)?(?:\s+total|\s+amount)?|won.t\s+be\s+charged|not\s+been\s+charged|credit(?:ed)?)[^$]{0,200}?\$\s*([\d,]+\.\d{2})/i;

export function cancelDetails(subject: string, body: string): CancelInfo {
  const t = `${subject}\n${body}`;
  const whole = WHOLE_CANCEL_RE.test(t) && !PARTIAL_CANCEL_RE.test(t);
  const released = body.match(RELEASED_RE);
  let amount = released ? money(released[1]) : extractCost(body, 'cancelled');
  if (!amount) {
    // One dollar figure in the whole email can only be what was cancelled.
    const figures = [...new Set([...body.matchAll(/\$\s*([\d,]+\.\d{2})/g)].map(m => money(m[1])))];
    if (figures.length === 1) amount = figures[0];
  }
  return { amount, whole };
}

// ---------------------------------------------------------------------------
// One message, parsed
// ---------------------------------------------------------------------------

export type HeaderLine = { key: string; line: string };

export type EmailInput = {
  subject: string;
  from: string;
  text: string;
  headerLines?: HeaderLine[];
};

export type ParsedOrderFields = {
  platform: EmailPlatform;
  kind: EmailKind;
  forwarded: boolean;
  subject: string; // the retailer's subject (unwrapped from a forward)
  from: string; // the retailer's From (unwrapped from a forward and an addy.io reverse alias)
  date: string; // the retailer's Date line from a forward, as written; '' when not a forward
  orderNumber: string;
  itemDescription: string;
  cost: number;
  shippingAddress: string;
  trackingNumbers: string[];
  recipients: string[]; // addresses the mail was sent to, or forwarded from
  senders: string[]; // the retailer's address(es)
  body: string;
  cancel?: CancelInfo; // cancellation emails only
};

// Headers that name where a message was delivered or forwarded to.
const RECIPIENT_HEADER_RE = /^(to|cc|delivered-to|x-original-to|x-forwarded-to|x-forwarded-for|envelope-to|x-.*original-to)$/i;

export function parseOrderEmail(input: EmailInput): ParsedOrderFields {
  const outerSubject = String(input.subject ?? '');
  const outerFrom = String(input.from ?? '');
  const text = String(input.text ?? '');
  const fwd = unwrapForwarded(text, outerSubject);

  const subject = fwd ? (fwd.subject || stripFwdPrefix(outerSubject)) : outerSubject;
  const from = unwrapReverseAlias(fwd ? fwd.from : outerFrom);
  const body = stripAddyBanner(fwd ? fwd.body : text);
  const kind = emailKind(subject);
  const platform = detectPlatform(from, subject);

  const recipients: string[] = [];
  const add = (list: string[]) => { for (const a of list) if (!recipients.includes(a)) recipients.push(a); };
  for (const h of input.headerLines ?? []) {
    if (RECIPIENT_HEADER_RE.test(h.key)) add(emailAddresses(h.line.replace(/^[^:]*:/, '')));
  }
  if (fwd) {
    add(emailAddresses(outerFrom)); // the person who forwarded it
    add(emailAddresses(fwd.to)); // who the retailer sent it to
  }

  return {
    platform,
    kind,
    forwarded: !!fwd,
    subject,
    from,
    date: fwd?.date ?? '',
    orderNumber: extractOrderNumber(`${subject}\n${body}`) || orderNumberFromLinks(body),
    itemDescription: itemFromSubject(subject) || itemFromBody(platform, body),
    cost: extractCost(body, kind),
    shippingAddress: extractShippingAddress(body),
    // Every email is read for tracking, whatever its subject says (Lenovo's
    // "Your order … is arriving soon" carries the UPS number).
    trackingNumbers: carriesOrderTracking(kind) ? [...new Set([...extractTrackingNumbers(body), ...trackingFromLinks(body)])] : [],
    recipients,
    senders: emailAddresses(from),
    body,
    ...(kind === 'cancelled' ? { cancel: cancelDetails(subject, body) } : {}),
  };
}

/** True when the message looks like a retailer order email worth listing. */
export function isOrderEmail(p: Pick<ParsedOrderFields, 'platform' | 'orderNumber'>): boolean {
  return p.platform !== 'Unknown' || !!p.orderNumber;
}

// ---------------------------------------------------------------------------
// Routing to a tracker user
// ---------------------------------------------------------------------------

export type RouteRule = { userId: number; pattern: string };
export type Routing = { userId: number | null; via: 'recipient' | 'sender' | 'only-user' | 'ambiguous' | 'none' };

function usersMatching(rules: readonly RouteRule[], addresses: readonly string[]): number[] {
  const ids: number[] = [];
  for (const r of rules) {
    const p = r.pattern.trim().toLowerCase();
    if (!p) continue;
    if (addresses.some(a => a.includes(p)) && !ids.includes(r.userId)) ids.push(r.userId);
  }
  return ids;
}

/**
 * Which user an email belongs to. The addresses it was sent to or forwarded
 * from decide first (minus the shared inbox itself); only when none of those
 * match a rule does the retailer's address get a say. Two users matching the
 * same tier is ambiguous and assigns nobody.
 */
export function routeEmail(
  rules: readonly RouteRule[],
  addrs: { recipients: readonly string[]; senders: readonly string[] },
  opts: { inboxAddress?: string; onlyUserId?: number | null } = {},
): Routing {
  if (opts.onlyUserId != null) return { userId: opts.onlyUserId, via: 'only-user' };
  const inbox = (opts.inboxAddress ?? '').trim().toLowerCase();
  const recipients = addrs.recipients.filter(a => a !== inbox);
  for (const [via, list] of [['recipient', recipients], ['sender', addrs.senders]] as const) {
    const ids = usersMatching(rules, list);
    if (ids.length === 1) return { userId: ids[0], via };
    if (ids.length > 1) return { userId: null, via: 'ambiguous' };
  }
  return { userId: null, via: 'none' };
}

// ---------------------------------------------------------------------------
// Import rows
// ---------------------------------------------------------------------------

export type EmailImportRow = {
  platform: string;
  orderNumber: string;
  orderDate: string;
  itemDescription: string;
  cost: number;
  shippingCost: number;
  salePrice: number | null;
  buyerId: string;
  cardId: string;
  cashbackAmount: number;
  shippingAddress?: string;
  trackingNumbers?: string[];
  cancelled?: boolean;
  updateOnly?: boolean;
};

export type EmailRowInput = Omit<EmailImportRow, 'cancelled' | 'updateOnly'> & { kind: EmailKind };

const digits = (s: string) => String(s ?? '').replace(/\D/g, '');

/**
 * One import row per order. The import route keeps only the first row it sees
 * for an order number, so an order's "Ordered" and "Shipped" emails picked in
 * the same batch are merged here: the order email's figures, every tracking
 * number, cancelled if any picked email cancels it. An order with no "Ordered"
 * email only updates an existing order (updateOnly). A shipping or delivery
 * note with no order number cannot be matched to anything and is dropped.
 */
export function mergeEmailImportRows(rows: readonly EmailRowInput[]): { rows: EmailImportRow[]; dropped: number } {
  const groups = new Map<string, EmailRowInput[]>();
  const out: EmailImportRow[] = [];
  let dropped = 0;
  for (const r of rows) {
    const key = digits(r.orderNumber);
    if (!key) {
      if (r.kind === 'ordered') out.push(toRow([r]));
      else dropped++;
      continue;
    }
    const g = groups.get(key);
    if (g) g.push(r); else groups.set(key, [r]);
  }
  for (const g of groups.values()) out.push(toRow(g));
  return { rows: out, dropped };
}

function toRow(group: readonly EmailRowInput[]): EmailImportRow {
  // A second "ordered" email for the same order (a notice) may carry no total.
  const orderedRows = group.filter(r => r.kind === 'ordered');
  const ordered = orderedRows.find(r => r.cost > 0) ?? orderedRows[0];
  const base = ordered ?? group[0];
  const first = <K extends keyof EmailRowInput>(k: K) => group.map(r => r[k]).find(v => v !== '' && v != null && v !== 0);
  const tracking: string[] = [];
  for (const r of group) for (const t of r.trackingNumbers ?? []) if (!tracking.includes(t)) tracking.push(t);
  const row: EmailImportRow = {
    platform: base.platform,
    orderNumber: base.orderNumber,
    orderDate: group.map(r => r.orderDate).filter(Boolean).sort()[0] ?? base.orderDate,
    itemDescription: (first('itemDescription') as string | undefined) ?? '',
    cost: ordered ? ordered.cost : 0,
    shippingCost: ordered ? ordered.shippingCost : 0,
    salePrice: (first('salePrice') as number | undefined) ?? null,
    buyerId: (first('buyerId') as string | undefined) ?? '',
    cardId: (first('cardId') as string | undefined) ?? '',
    cashbackAmount: ordered ? ordered.cashbackAmount : 0,
    shippingAddress: (first('shippingAddress') as string | undefined) ?? '',
  };
  if (tracking.length) row.trackingNumbers = tracking;
  if (group.some(r => r.kind === 'cancelled')) row.cancelled = true;
  if (!ordered) row.updateOnly = true;
  return row;
}

// ---------------------------------------------------------------------------
// HTML-only messages
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Plain text from an HTML body: block tags become line breaks, the rest is dropped. */
export function htmlToText(html: string): string {
  return String(html ?? '')
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
