import { createHash } from 'node:crypto';
import { MAX_LINE_CHARS, cutLine } from './digestPrivate.ts';

// Inbox triage: mail the app did not recognize is redacted and sent to a local
// model for a recommendation. Pure, no I/O (lib/inboxTriageRun.ts does the work).

export const BODY_MAX_CHARS = 4000;

/** The lowercased domain of the sender address, or '' when there is none. */
export function senderDomain(from: string): string {
  const m = /[^\s<>"',;()]+@([a-z0-9.-]+)/i.exec(String(from ?? ''));
  return m ? m[1].toLowerCase().replace(/^\.+|\.+$/g, '') : '';
}

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
// What must survive the number rule: dates and currency amounts.
const KEEP = [
  '\\b\\d{4}-\\d{2}-\\d{2}\\b',
  `\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b`,
  `\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH},?\\s+\\d{4}\\b`,
  '[$€£¥]\\s?\\d[\\d,]*(?:\\.\\d+)?',
  '\\b\\d[\\d,]*\\.\\d{2}\\b',
  '\\b\\d{1,2}/\\d{1,2}/\\d{2,4}\\b',
].join('|');
// Groups of digits may be split by a space, dot, slash or hyphen. A dot or slash before exactly two digits is
// left out of the run so "Qty 10 19.99" keeps its price.
const NUMBER_RE = new RegExp(`(${KEEP})|\\d(?:(?:[ -]|[./](?!\\d{2}(?!\\d)))?\\d){5,}`, 'gi');

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi;
// A link with no scheme: a host with a dot, then a path.
const BARE_LINK_RE = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s<>"')\]]*/gi;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /(?<![\w$]|\d[.,])(?:\+?\d{1,2}[\s.-])?(?:\(\d{3}\)\s?|\d{3}[\s.-]?)\d{3}[\s.-]?\d{4}(?!\d|-\d)/g;
const STREET_WORDS = 'St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Ct|Court|Way|Pl|Place|Pkwy|Parkway|Cir|Circle|Ter|Terrace|Trl|Trail|Hwy|Highway|Sq|Square|Loop';
// Anywhere in the text, since an HTML-only mail can come out as one line. A trailing direction (NW) goes with it.
const ADDRESS_RE = new RegExp(`\\b\\d{1,6}(?:\\s+[A-Za-z0-9][\\w'.-]*){1,3}?\\s+(?:${STREET_WORDS})\\b\\.?(?:\\s+(?:NE|NW|SE|SW|N|S|E|W)\\b\\.?)?`, 'gi');
// Case matters here: two capital letters and a ZIP.
const STATE_ZIP_RE = /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/g;
const NAME = String.raw`(?:(?:Mr|Mrs|Ms|Miss|Mx|Dr)\.?\s+)?\p{Lu}[\p{L}'’-]*(?:\s+\p{Lu}[\p{L}'’-]*){0,2}`;
const GREETING_RE = new RegExp(String.raw`^(\s*(?:Hi|Hello|Hey|Dear))[\s,]+${NAME}`, 'u');
// The same after the whitespace is collapsed, for a greeting that follows a sentence in a one-line mail.
const GREETING_INLINE_RE = new RegExp(String.raw`(?<=^|[.!?:]\s)((?:Hi|Hello|Hey|Dear))[\s,]+${NAME}`, 'gu');
// Bearer secrets that are often short: a PIN is 4 digits. A word after the label is kept unless it has a digit or follows ":" or "#".
const SECRET_RE = /\b(PIN|pass ?code|security code|access (?:code|number)|claim code|redemption code|CVV|CVC)\b([\s:#]*)(?:is\s+)?([A-Z0-9][A-Z0-9-]*(?:\s\d[A-Z0-9-]*){0,5})/gi;
// Any token of 8 or more letters, digits and dashes that has both a letter and a digit.
const CODE_RE = /\b(?=[A-Z0-9-]{8,}\b)(?=[A-Z-]*\d)(?=[0-9-]*[A-Z])[A-Z0-9-]+\b/gi;

const linkText = (m: string): string => {
  const trail = /[.,;:!?]+$/.exec(m)?.[0] ?? '';
  const host = m.replace(/^(?:https?:\/\/)?(?:www\.)?/i, '').split(/[/?#:]/)[0].toLowerCase().replace(/[^a-z0-9.-]/g, '');
  return `[link${host ? ` ${host}` : ''}]${trail}`;
};

function redactText(s: string): string {
  // Greeting names first: they are tied to a line start. Then everything is one line, so a number split by a
  // non-breaking space or a line break is whole before the passes below look for it.
  const lines = String(s ?? '').split(/\r?\n/).map(l => l.replace(GREETING_RE, '$1 [name]'));
  return lines.join('\n')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(GREETING_INLINE_RE, '$1 [name]')
    .replace(ADDRESS_RE, '[address]')
    .replace(STATE_ZIP_RE, '[address]')
    .replace(URL_RE, linkText)
    .replace(EMAIL_RE, '[email]')
    .replace(BARE_LINK_RE, linkText)
    .replace(SECRET_RE, (m: string, label: string, sep: string, token: string) => (/\d/.test(token) || /[:#]/.test(sep) ? `${label} [code]` : m))
    .replace(PHONE_RE, '[phone]')
    .replace(CODE_RE, '[code]')
    .replace(NUMBER_RE, (m, keep) => (keep ? m : '[number]'))
    .trim();
}

/** The one string sent to the model: the sender's domain, then subject and body with personal data removed. */
export function redactForTriage(m: { fromDomain: string; subject: string; text: string }): string {
  const domain = String(m.fromDomain ?? '').replace(/[^a-z0-9.-]/gi, '').toLowerCase();
  return `From domain: ${domain}\nSubject: ${redactText(m.subject).slice(0, 300)}\n\n${redactText(m.text).slice(0, BODY_MAX_CHARS)}`;
}

export const TRIAGE_SYSTEM = `You triage one email from a reseller's order inbox. The person buys items and gift cards online and resells them. They also rent computers out for paid compute jobs, which brings bills, leases, payouts and store-card statements. The app already recognizes order, shipping and payment emails and known noise, so this one is something it did not recognize.

The email has been redacted before you see it: [email], [link domain], [phone], [number], [address] and [name] are placeholders for removed personal data. Amounts, dates and merchant names are left in. Do not try to guess what a placeholder hid.

Answer with ONE JSON object only, no other text:
{"category": "order"|"shipping"|"payment"|"bill"|"account"|"marketing"|"personal"|"other",
 "recommend": "ingest"|"ignore"|"review",
 "reason": string (at most 200 characters, no personal data),
 "ignore_rule": {"from_domain": string, "subject_contains": string|null} or null (only when recommend is "ignore": the narrowest rule that would match this kind of email),
 "ingest_kind": string|null (when recommend is "ingest": what the app should record, e.g. "lease bill", "card statement", "payout", "receipt"),
 "fields": an object of the key values a parser would need (field names with the values seen, e.g. amount due, due date, merchant), or {}}

"ingest" = it records money, an order or a delivery the tracker should keep.
"ignore" = newsletters, promotions, notices with nothing to record.
"review" = you are unsure, or it looks personal.`;

export type TriageCategory = 'order' | 'shipping' | 'payment' | 'bill' | 'account' | 'marketing' | 'personal' | 'other';
export type TriageRecommend = 'ingest' | 'ignore' | 'review';
export type TriageResult = {
  category: TriageCategory;
  recommend: TriageRecommend;
  reason: string;
  ignoreRule: { fromDomain: string; subjectContains: string | null } | null;
  ingestKind: string | null;
  fields: Record<string, string>;
};

const CATEGORIES: readonly string[] = ['order', 'shipping', 'payment', 'bill', 'account', 'marketing', 'personal', 'other'];
const RECOMMENDS: readonly string[] = ['ingest', 'ignore', 'review'];
const MAX_FIELDS = 12;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The model's answer checked field by field; null when it is not the shape asked for. Unknown keys are dropped. */
export function parseTriageResult(raw: unknown): TriageResult | null {
  if (!isObject(raw)) return null;
  const { category, recommend, reason } = raw;
  if (typeof category !== 'string' || !CATEGORIES.includes(category)) return null;
  if (typeof recommend !== 'string' || !RECOMMENDS.includes(recommend)) return null;
  if (typeof reason !== 'string') return null;

  let ignoreRule: TriageResult['ignoreRule'] = null;
  const rule = raw.ignore_rule;
  if (rule != null) {
    if (!isObject(rule) || typeof rule.from_domain !== 'string') return null;
    const sub = rule.subject_contains;
    if (sub != null && typeof sub !== 'string') return null;
    const fromDomain = rule.from_domain.trim().toLowerCase().slice(0, 100);
    const subjectContains = typeof sub === 'string' && sub.trim() ? sub.trim().slice(0, 80) : null;
    if (fromDomain && recommend === 'ignore') ignoreRule = { fromDomain, subjectContains };
  }

  const kind = raw.ingest_kind;
  if (kind != null && typeof kind !== 'string') return null;
  const ingestKind = recommend === 'ingest' && typeof kind === 'string' && kind.trim() ? kind.trim().slice(0, 60) : null;

  const fields: Record<string, string> = {};
  if (raw.fields != null) {
    if (!isObject(raw.fields)) return null;
    for (const [k, v] of Object.entries(raw.fields)) {
      if (Object.keys(fields).length >= MAX_FIELDS) break;
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') continue;
      const key = k.trim().slice(0, 40);
      if (key) Object.defineProperty(fields, key, { value: String(v).slice(0, 120), enumerable: true, writable: true, configurable: true });
    }
  }

  return { category: category as TriageCategory, recommend: recommend as TriageRecommend, reason: reason.trim().slice(0, 200), ignoreRule, ingestKind, fields };
}

export type IgnoreRule = { fromDomain: string; subjectContains: string | null };

/** The first rule that matches: the sender's domain is the rule's or a subdomain of it, and the subject has the rule's text. */
export function findIgnoreRule<T extends IgnoreRule>(rules: readonly T[], fromDomain: string, subject: string): T | null {
  const domain = String(fromDomain ?? '').toLowerCase();
  if (!domain) return null;
  const subj = String(subject ?? '').toLowerCase();
  for (const r of rules) {
    const rd = r.fromDomain.trim().toLowerCase();
    if (!rd || (domain !== rd && !domain.endsWith(`.${rd}`))) continue;
    const need = r.subjectContains?.trim().toLowerCase();
    if (need && !subj.includes(need)) continue;
    return r;
  }
  return null;
}

export function matchesIgnoreRule(rules: readonly IgnoreRule[], fromDomain: string, subject: string): boolean {
  return findIgnoreRule(rules, fromDomain, subject) !== null;
}

// Never an ignore rule on their own: a rule here would match mail from far more than one sender.
const PUBLIC_SUFFIXES = new Set(['com', 'net', 'org', 'io', 'co', 'us', 'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'co.in', 'com.br']);
// Shared by everyone, so a domain rule would ignore mail from strangers too.
const FREE_MAIL = new Set(['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'aol.com', 'proton.me', 'pm.me']);
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** A bare lowercase domain from "@klarna.com", "https://klarna.com/x" or "Klarna.com.", or '' when it is not a domain with at least two labels. */
export function normalizeDomain(s: string): string {
  const d = String(s ?? '').trim().toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^[^@/\s]*@/, '')
    .split(/[/?#\s]/)[0]
    .replace(/:\d+$/, '')
    .replace(/^\.+|\.+$/g, '');
  return DOMAIN_RE.test(d) ? d : '';
}

const tooBroad = (d: string): boolean => PUBLIC_SUFFIXES.has(d) || FREE_MAIL.has(d);

/**
 * The ignore rule "Ignore sender" may create for a row, or null when none is safe. The model's domain is used
 * only when it is the sender's domain or a parent of it and not a public suffix or free-mail domain; anything
 * else falls back to the sender's own domain and drops the subject part. The mail body steers the model, so
 * its answer is not trusted to widen the rule.
 */
export function safeIgnoreRule(row: { fromDomain: string; ruleFromDomain: string | null; ruleSubject: string | null }): IgnoreRule | null {
  const own = normalizeDomain(row.fromDomain);
  if (!own || tooBroad(own)) return null;
  const asked = normalizeDomain(row.ruleFromDomain ?? '');
  if (asked && !tooBroad(asked) && (asked === own || own.endsWith(`.${asked}`))) {
    return { fromDomain: asked, subjectContains: row.ruleSubject?.trim() || null };
  }
  return { fromDomain: own, subjectContains: null };
}

/** What a failed queue call means: this message alone was refused ('rejected'), or the queue is not usable now ('stop'). Safe on null and odd values. */
export function submitErrorKind(e: unknown): { kind: 'rejected' | 'stop'; status: number | null } {
  const s = (e as { status?: unknown } | null | undefined)?.status;
  const status = typeof s === 'number' ? s : null;
  return { kind: status === 413 || status === 422 ? 'rejected' : 'stop', status };
}

/** A job ref that fits the queue's rule (A-Z a-z 0-9 . _ : -, 64 at most) and is the same for the same message. */
export function triageRef(messageId: string): string {
  return `triage:${createHash('sha1').update(String(messageId)).digest('hex').slice(0, 20)}`;
}

/** The digest line for the day's unrecognized mail, or null when there was none. Counts only, so the queue accepts it. */
export function triageDigestLine(c: { found: number; ignore: number; ingest: number; review: number }): string | null {
  if (c.found <= 0) return null;
  const parts: string[] = [];
  if (c.ingest > 0) parts.push(`${c.ingest} to ingest`);
  if (c.ignore > 0) parts.push(`${c.ignore} to ignore`);
  if (c.review > 0) parts.push(`${c.review} to review`);
  const head = `Inbox triage: ${c.found} unrecognized email${c.found === 1 ? '' : 's'}`;
  const line = `${head}${parts.length ? ` (${parts.join(', ')})` : ''}.`;
  return Array.from(line).length > MAX_LINE_CHARS ? cutLine(line) : line;
}
