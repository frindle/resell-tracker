import { createHash } from 'node:crypto';
import { MAX_LINE_CHARS, cutLine } from './digestPrivate.ts';

// Inbox triage: mail the app did not recognize is redacted and sent to a local
// model for a recommendation. Pure, no I/O (lib/inboxTriageRun.ts does the work).

export const BODY_MAX_CHARS = 4000;
export const SUBJECT_MAX_CHARS = 300;

/** The first n characters, cut by code point so an emoji is never split into a lone half. */
export function cutChars(s: string, n: number): string {
  return Array.from(s).slice(0, n).join('');
}

/**
 * The lowercased domain of the sender address, or '' when there is none. Only the text after the last "@" counts,
 * and an address with a second "@" or a quote in it is refused: "service@paypal.com"@evil.example is evil.example's.
 */
export function senderDomain(from: string): string {
  const raw = String(from ?? '').trim();
  // With a display name the address is the part in <...>; the name may hold quotes and an "@" of its own.
  const addr = /<([^<>]*)>[^<>]*$/.exec(raw)?.[1] ?? raw;
  if (/["'`“”‘’]/.test(addr) || addr.split('@').length !== 2) return '';
  return normalizeDomain(addr.slice(addr.lastIndexOf('@') + 1));
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
// Groups of digits may be split by a space, dot, slash or hyphen (a hyphen may have a space on either side). A dot or
// slash before exactly two digits is left out of the run so "Qty 10 19.99" keeps its price.
const NUMBER_RE = new RegExp(`(${KEEP})|\\d(?:(?:\\s?-\\s?|\\s|[./](?!\\d{2}(?!\\d)))?\\d){5,}`, 'gi');

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi;
// A link with no scheme: a host with a dot, then a path.
const BARE_LINK_RE = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s<>"')\]]*/gi;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /(?<![\w$]|\d[.,])(?:\+?\d{1,2}[\s.-])?(?:\(\d{3}\)\s?|\d{3}[\s.-]?)\d{3}[\s.-]?\d{4}(?!\d|-\d)/g;
const STREET_WORDS = 'St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Ct|Court|Way|Pl|Place|Pkwy|Parkway|Cir|Circle|Ter|Terrace|Trl|Trail|Hwy|Highway|Sq|Square|Loop';
// Anywhere in the text, since an HTML-only mail can come out as one line. A trailing direction (NW) goes with it.
// The suffix must be capitalised (or all caps) so "2 items on the way" is not a street.
const STREET_RE_WORDS = STREET_WORDS.split('|').flatMap(w => [w, w.toUpperCase()]).join('|');
const ADDRESS_RE = new RegExp(`\\b\\d{1,6}(?:\\s+[A-Za-z0-9][\\w'.-]*){1,5}?\\s+(?:${STREET_RE_WORDS})\\b\\.?(?:\\s+(?:NE|NW|SE|SW|N|S|E|W)\\b\\.?)?`, 'g');
// Streets with no suffix word, and PO boxes.
const ADDRESS_MORE_RE = /\b\d{1,6}\s+(?:Avenue of the [A-Z][a-z]+|Broadway\b)|\bP\.?\s?O\.?\s?Box\s+\d+\b/gi;
// Case matters here: two capital letters and a ZIP.
const STATE_ZIP_RE = /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/g;
// A ZIP after a comma and a state written out ("Springfield, Illinois 62704").
const COMMA_ZIP_RE = /,\s*[\p{L} ]{0,30}\d{5}(?:-\d{4})?\b/gu;
const NAME_CHAR = String.raw`[\p{L}\p{M}'’-]`;
// A first word in lower case is a name too ("Hi jane,"), unless it is one of these.
const NOT_A_NAME = 'and|there|all|everyone|team|from|to|the|your|you|we|our|this|that|just|so|is|a|an|it|valued|again';
const NAME = String.raw`(?:(?:Mr|Mrs|Ms|Miss|Mx|Dr)\.?\s+)?(?:\p{Lu}${NAME_CHAR}*|(?!(?:${NOT_A_NAME})(?![\p{L}\p{M}]))\p{Ll}${NAME_CHAR}*)(?:\s+\p{Lu}${NAME_CHAR}*){0,2}`;
// Anywhere, with \b: a greeting can follow a sentence or the sender's name in a one-line mail.
const GREETING_RE = new RegExp(String.raw`\b((?:[Hh]i|[Hh]ello|[Hh]ey|[Dd]ear|HI|HELLO|HEY|DEAR))[\s,]+${NAME}`, 'gu');
// Names after a label ("Ship to: Jane Doe"). The label is matched in any case; the words after it must be capitalised.
const NAME_LABEL_RE = /\b(?:(?:ship(?:ped)?|bill(?:ed)?|deliver(?:ed)?|sold) to\b\s*:?|(?:recipient|name|card ?holder(?: name)?|attn|attention)\b\s*:)\s*/giu;
const NAME_WORDS_RE = new RegExp(String.raw`^(?:(?:Mr|Mrs|Ms|Miss|Mx|Dr)\.? )?\p{Lu}${NAME_CHAR}*(?: \p{Lu}${NAME_CHAR}*){0,3}`, 'u');
// "Jane, your cart is waiting": a lone capitalised first word and a comma, unless it is an ordinary word.
const SUBJECT_NAME_RE = /^(\p{Lu}[\p{L}\p{M}'’-]*),\s*/u;
const COMMON_LEADS = new Set(['hurry', 'update', 'reminder', 'welcome', 'congratulations', 'thanks', 'sorry', 'urgent', 'important', 'attention', 'today', 'tomorrow', 'yes', 'no', 'please', 'note', 'alert', 'hello', 'hi', 'hey', 'dear', 'finally', 'breaking']);
// Bearer secrets that are often short: a PIN is 4 digits.
const SECRET_LABEL = String.raw`\b(?:PIN(?: number)?|pass ?code|security code|access (?:code|number)|claim code|redemption code|CVV|CVC|OTP|(?:(?:verification|gift(?: card)?|card|activation|one[- ]time)\s*)?code)\b`;
const SECRET_WINDOW = 30;
// Any token of 8 or more letters, digits and dashes that has both a letter and a digit.
const CODE_RE = /\b(?=[A-Z0-9-]{8,}\b)(?=[A-Z-]*\d)(?=[0-9-]*[A-Z])[A-Z0-9-]+\b/gi;
// Three or more short groups in capitals and digits ("XQ7K 9LMP 2WRT 4HJN"); case matters, and one group needs a digit.
const CODE_RUN_RE = /\b(?:[A-Z0-9]{3,6}[ -]){2,}[A-Z0-9]{3,6}\b/g;

const linkText = (m: string): string => {
  const trail = /[.,;:!?]+$/.exec(m)?.[0] ?? '';
  const host = m.replace(/^(?:https?:\/\/)?(?:www\.)?/i, '').split(/[/?#:]/)[0].toLowerCase().replace(/[^a-z0-9.-]/g, '');
  return `[link${host ? ` ${host}` : ''}]${trail}`;
};

// One spelling for what a mail can write many ways: full-width digits, ligatures, hidden characters and the dashes.
function normalizeText(s: string): string {
  return String(s ?? '').normalize('NFKC')
    .replace(/[­​-‍⁠﻿]/g, '')
    .replace(/[‐-―−]/g, '-');
}

// "Ship to: Jane Doe": the capitalised words right after a label are a name.
function redactLabelledNames(s: string): string {
  let out = '';
  let at = 0;
  for (const m of s.matchAll(NAME_LABEL_RE)) {
    const from = (m.index ?? 0) + m[0].length;
    if (from < at) continue;
    const name = NAME_WORDS_RE.exec(s.slice(from));
    if (!name) continue;
    out += `${s.slice(at, from)}[name]`;
    at = from + name[0].length;
  }
  return out + s.slice(at);
}

// What follows a secret's label: from the label to the value becomes " [code]". Null when nothing there looks like a value.
function secretTail(rest: string): string | null {
  let w = rest.slice(0, SECRET_WINDOW);
  // Never cut a token in two: its second half would be left in the clear.
  while (w.length < rest.length && /[A-Za-z0-9-]$/.test(w) && /[A-Za-z0-9-]/.test(rest[w.length])) w += rest[w.length];
  const stop = w.search(/[.!?](?:\s|$)/);
  if (stop >= 0) w = w.slice(0, stop);
  // "PIN is: 4821", "code - 55210": skip the punctuation and an "is". After ":", "#" or "=" the next word is the value even without a digit.
  const lead = /^[^A-Za-z0-9]*(?:is\b[^A-Za-z0-9]*)?/.exec(w)?.[0] ?? '';
  const labelled = /[:#=]/.test(lead);
  const first = [...w.matchAll(/[A-Za-z0-9][A-Za-z0-9-]*/g)].find(t => (t.index ?? 0) >= lead.length && (labelled || /\d/.test(t[0])));
  if (!first) return null;
  let end = (first.index ?? 0) + first[0].length;
  // The groups that follow: "AQ7X KRBNZK 49PL".
  for (let n = 0; n < 5; n++) {
    const g = /^ ([A-Za-z0-9-]+)(?![A-Za-z0-9-])/.exec(rest.slice(end));
    if (!g || !(/\d/.test(g[1]) || /^[A-Z0-9-]{3,8}$/.test(g[1]))) break;
    end += 1 + g[1].length;
  }
  // Any other token with a digit in the rest of the window goes too.
  const after = end < w.length ? w.slice(end).replace(/[A-Za-z0-9][A-Za-z0-9-]*/g, t => (/\d/.test(t) ? '[code]' : t)) : '';
  return ` [code]${after}${rest.slice(Math.max(end, w.length))}`;
}

function redactSecrets(s: string): string {
  const re = new RegExp(SECRET_LABEL, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const from = m.index + m[0].length;
    const tail = secretTail(s.slice(from));
    if (tail === null) continue;
    s = s.slice(0, from) + tail;
    // Resume after the placeholder, which has the word "code" in it.
    re.lastIndex = from + ' [code]'.length;
  }
  return s;
}

const looksLikeCode = (t: string): boolean => {
  if (/^\d{1,2}-[a-z]{3,9}-\d{2,4}$/i.test(t)) return false; // a date: 28-Nov-2026
  const core = t.replace(/-\d+$/, ''); // a year or version at the end does not make a code: COVID-19
  return (core.match(/\d/g)?.length ?? 0) >= 2 && (core.match(/[a-z]/gi)?.length ?? 0) >= 2;
};

// Words the account itself holds (its names, saved address rules), removed whole-word and in any case.
function termsRe(terms: readonly string[]): RegExp | null {
  const list = [...new Set(terms.map(t => normalizeText(t).replace(/\s+/g, ' ').trim().toLowerCase()).filter(t => Array.from(t).length >= 3))]
    .sort((a, b) => b.length - a.length);
  if (!list.length) return null;
  const alt = list.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alt})(?![\\p{L}\\p{N}])`, 'giu');
}

function redactText(s: string, extra: RegExp | null, subject = false): string {
  // Greeting names first: they are tied to a line. Then everything is one line, so a number split by a
  // non-breaking space or a line break is whole before the passes below look for it.
  const lines = normalizeText(s).split(/\r?\n/).map(l => l.replace(GREETING_RE, '$1 [name]'));
  let t = lines.join('\n').replace(/\s+/g, ' ').trim();
  if (subject) t = t.replace(SUBJECT_NAME_RE, (m: string, word: string) => (COMMON_LEADS.has(word.toLowerCase()) ? m : '[name], '));
  t = redactLabelledNames(t.replace(GREETING_RE, '$1 [name]'))
    .replace(ADDRESS_RE, '[address]')
    .replace(ADDRESS_MORE_RE, '[address]')
    .replace(STATE_ZIP_RE, '[address]')
    .replace(COMMA_ZIP_RE, ', [address]')
    .replace(URL_RE, linkText)
    .replace(EMAIL_RE, '[email]')
    .replace(BARE_LINK_RE, linkText);
  // After the email pass: a name cut out of an address would leave "[name]@example.com" whole.
  if (extra) t = t.replace(extra, '[name]');
  return redactSecrets(t)
    .replace(PHONE_RE, '[phone]')
    .replace(CODE_RE, m => (looksLikeCode(m) ? '[code]' : m))
    .replace(NUMBER_RE, (m, keep) => (keep ? m : '[number]'))
    .replace(CODE_RUN_RE, m => (/\d/.test(m) ? '[code]' : m))
    .trim();
}

/**
 * The one string sent to the model: the sender's domain, then subject and body with personal data removed.
 * extraTerms (the account's own names and saved address rules) are removed verbatim, in any case.
 */
export function redactForTriage(m: { fromDomain: string; subject: string; text: string }, extraTerms: readonly string[] = []): string {
  const domain = String(m.fromDomain ?? '').replace(/[^a-z0-9.-]/gi, '').toLowerCase();
  const extra = termsRe(extraTerms);
  return `From domain: ${domain}\nSubject: ${cutChars(redactText(m.subject, extra, true), SUBJECT_MAX_CHARS)}\n\n${cutChars(redactText(m.text, extra), BODY_MAX_CHARS)}`;
}

export const TRIAGE_SYSTEM = `You triage one email from a reseller's order inbox. The person buys items and gift cards online and resells them. They also rent computers out for paid compute jobs, which brings bills, leases, payouts and store-card statements. The app already recognizes order, shipping and payment emails and known noise, so this one is something it did not recognize.

The email has been redacted before you see it: [email], [link domain], [phone], [number], [address], [code] and [name] are placeholders for removed personal data. Amounts, dates and merchant names are left in. Do not try to guess what a placeholder hid.

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
    const fromDomain = cutChars(rule.from_domain.trim().toLowerCase(), 100);
    const subjectContains = typeof sub === 'string' && sub.trim() ? cutChars(sub.trim(), 80) : null;
    if (fromDomain && recommend === 'ignore') ignoreRule = { fromDomain, subjectContains };
  }

  const kind = raw.ingest_kind;
  if (kind != null && typeof kind !== 'string') return null;
  const ingestKind = recommend === 'ingest' && typeof kind === 'string' && kind.trim() ? cutChars(kind.trim(), 60) : null;

  const fields: Record<string, string> = {};
  if (raw.fields != null) {
    if (!isObject(raw.fields)) return null;
    for (const [k, v] of Object.entries(raw.fields)) {
      if (Object.keys(fields).length >= MAX_FIELDS) break;
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') continue;
      const key = cutChars(k.trim(), 40);
      if (key) Object.defineProperty(fields, key, { value: cutChars(String(v), 120), enumerable: true, writable: true, configurable: true });
    }
  }

  return { category: category as TriageCategory, recommend: recommend as TriageRecommend, reason: cutChars(reason.trim(), 200), ignoreRule, ingestKind, fields };
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
// Two labels, a generic one and a country code (com.mx, co.za): a public suffix without carrying the whole list.
const SUFFIX_FIRST_LABELS = new Set(['com', 'co', 'net', 'org', 'gov', 'edu', 'ac', 'gob', 'ne', 'or', 'ltd', 'plc']);
// Hosting names anyone can register under, so a rule on one would match strangers' mail.
const PRIVATE_SUFFIXES = new Set([
  'myshopify.com', 'github.io', 'herokuapp.com', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'blogspot.com', 'wixsite.com',
  'squarespace.com', 'azurewebsites.net', 'cloudfront.net', 'amazonaws.com', 'appspot.com', 'firebaseapp.com', 'web.app', 'substack.com', 'mailchimpapp.com',
]);
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

const isPublicSuffix = (d: string): boolean => {
  if (PUBLIC_SUFFIXES.has(d) || PRIVATE_SUFFIXES.has(d)) return true;
  const p = d.split('.');
  return p.length === 2 && SUFFIX_FIRST_LABELS.has(p[0]) && /^[a-z]{2}$/.test(p[1]);
};

const tooBroad = (d: string): boolean => isPublicSuffix(d) || FREE_MAIL.has(d);

/** The public suffix plus one label (news.tienda.com.mx is tienda.com.mx), or null when the domain is itself a public suffix. */
function registrableDomain(d: string): string | null {
  const labels = d.split('.');
  // The longest public suffix first.
  for (let i = 0; i < labels.length; i++) {
    if (isPublicSuffix(labels.slice(i).join('.'))) return i > 0 ? labels.slice(i - 1).join('.') : null;
  }
  // A suffix not in the lists: take the last label as the suffix.
  return labels.length >= 2 ? labels.slice(-2).join('.') : null;
}

/**
 * The ignore rule "Ignore sender" may create for a row, or null when none is safe. The model's domain is used
 * only when it is the sender's registrable domain, the sender's full domain or a domain between them, and not a
 * public suffix or free-mail domain; anything else falls back to the sender's own domain and drops the subject
 * part. The mail body steers the model, so its answer is not trusted to widen the rule.
 */
export function safeIgnoreRule(row: { fromDomain: string; ruleFromDomain: string | null; ruleSubject: string | null }): IgnoreRule | null {
  const own = normalizeDomain(row.fromDomain);
  const reg = own ? registrableDomain(own) : null;
  if (!own || !reg || tooBroad(own)) return null;
  const asked = normalizeDomain(row.ruleFromDomain ?? '');
  if (asked && !tooBroad(asked) && (asked === own || own.endsWith(`.${asked}`)) && (asked === reg || asked.endsWith(`.${reg}`))) {
    return { fromDomain: asked, subjectContains: row.ruleSubject?.trim() || null };
  }
  return { fromDomain: own, subjectContains: null };
}

/**
 * What a failed queue call means: the queue answered with an HTTP status about this message ('rejected'), or it is
 * not usable now ('stop'): no status (network error, timeout), 401 and 403 (bad token), 429 (rate limit).
 * Safe on null and odd values.
 */
export function submitErrorKind(e: unknown): { kind: 'rejected' | 'stop'; status: number | null } {
  const s = (e as { status?: unknown } | null | undefined)?.status;
  const status = typeof s === 'number' && Number.isInteger(s) && s >= 100 && s <= 599 ? s : null;
  return { kind: status !== null && status !== 401 && status !== 403 && status !== 429 ? 'rejected' : 'stop', status };
}

/**
 * What the run does after a failed submit. prevRejected is the status the run's previous submit was refused with
 * (null when it was not): the same refusal twice in a row means the queue is likely misconfigured, so both messages
 * wait for a retry ('park') instead of being failed one by one.
 */
export function submitStep(e: unknown, prevRejected: number | null): { action: 'stop' | 'fail' | 'park'; status: number | null } {
  const { kind, status } = submitErrorKind(e);
  if (kind === 'stop') return { action: 'stop', status };
  return { action: status === prevRejected ? 'park' : 'fail', status };
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
