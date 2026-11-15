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

export type EmailPlatform = 'Amazon' | 'Walmart' | 'BuyingGroup' | 'Costco' | 'Unknown';
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
        const part = take(i);
        if (part) return part;
      }
    }
  }
  return null;
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
  return 'Unknown';
}

/** What happened to the order, from the subject. Most specific first. */
export function emailKind(subject: string): EmailKind {
  const s = stripFwdPrefix(subject).toLowerCase();
  if (/\bcancel/.test(s)) return 'cancelled';
  if (/\brefund|\breturn/.test(s)) return 'refund';
  if (/\bdelivered\b/.test(s)) return 'delivered';
  if (/\bshipped\b|\bon (?:its|the) way\b|\bout for delivery\b|\bshipment\b|\bhas shipped\b/.test(s)) return 'shipped';
  if (/\bordered\b|\border confirm|\bthanks for your order|\bthank you for your order|\byour order\b|\border (?:placed|received)\b|\byour .*order\b/.test(s)) return 'ordered';
  return 'other';
}

/** Item title quoted in the subject, e.g. Ordered: "Echo Dot" and 2 more items. */
export function itemFromSubject(subject: string): string {
  const s = stripFwdPrefix(subject);
  const m = s.match(/["“]([^"”]{2,})["”]/);
  if (!m) return '';
  const title = m[1].trim().replace(/\.{3}$|…$/, '').trim();
  const more = s.slice((m.index ?? 0) + m[0].length).match(/and\s+(\d+)\s+more\s+items?/i);
  return more ? `${title} (+${more[1]} more)` : title;
}

const ORDER_PATTERNS: RegExp[] = [
  // Amazon: 123-1234567-1234567
  /\b(\d{3}-\d{7}-\d{7})\b/,
  // Walmart and others: 10+ digits after # or "order"
  /(?:#|order\s*(?:number|#|no\.?)?[\s:]*)(\d{10,})/i,
  // Generic: "order number ABC123" — must contain a digit
  /order\s*(?:id|number|#|no\.?)[\s:#]*([A-Z0-9-]*\d[A-Z0-9-]{5,})/i,
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
    /(?<![a-z])total(?:\s+charged|\s+amount)?[^\d$a-z]{0,40}\$\s*([\d,]+\.\d{2})/i,
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

export function extractShippingAddress(text: string): string {
  const t = String(text ?? '');
  const m = /(?:\bship(?:ping|ped)?\s+to|\bdeliver(?:y|ed|ing)\s+to)\s*:?[ \t]*/i.exec(t);
  if (!m) return '';
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
  from: string; // the retailer's From (unwrapped from a forward)
  orderNumber: string;
  itemDescription: string;
  cost: number;
  shippingAddress: string;
  trackingNumbers: string[];
  recipients: string[]; // addresses the mail was sent to, or forwarded from
  senders: string[]; // the retailer's address(es)
  body: string;
};

// Headers that name where a message was delivered or forwarded to.
const RECIPIENT_HEADER_RE = /^(to|cc|delivered-to|x-original-to|x-forwarded-to|x-forwarded-for|envelope-to|x-.*original-to)$/i;

export function parseOrderEmail(input: EmailInput): ParsedOrderFields {
  const outerSubject = String(input.subject ?? '');
  const outerFrom = String(input.from ?? '');
  const text = String(input.text ?? '');
  const fwd = unwrapForwarded(text, outerSubject);

  const subject = fwd ? (fwd.subject || stripFwdPrefix(outerSubject)) : outerSubject;
  const from = fwd ? fwd.from : outerFrom;
  const body = fwd ? fwd.body : text;
  const kind = emailKind(subject);

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
    platform: detectPlatform(from, subject),
    kind,
    forwarded: !!fwd,
    subject,
    from,
    orderNumber: extractOrderNumber(`${subject}\n${body}`),
    itemDescription: itemFromSubject(subject),
    cost: extractCost(body, kind),
    shippingAddress: extractShippingAddress(body),
    trackingNumbers: kind === 'shipped' || kind === 'delivered' ? extractTrackingNumbers(body) : [],
    recipients,
    senders: emailAddresses(from),
    body,
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
  const ordered = group.find(r => r.kind === 'ordered');
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
