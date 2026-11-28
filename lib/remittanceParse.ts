// Group payment ("remittance") emails: a buying group tells us what it paid, which tracking numbers the payment covers and the
// value of each. Pure, no I/O. One parser per group; a new group is one function in REMITTANCE_PARSERS plus a fixture test.
import { normTracking } from './bgReceiptEmail.ts';

/** One line of a remittance: a tracking number and the cents paid for it. */
export type RemittanceLine = { tracking: string; amountCents: number };

/** What a group's payment email says. `ref` is the group's own payment id when the email carries one. */
export type RemittanceParse = {
  group: string;
  ref: string | null;
  totalCents: number;
  /** YYYY-MM-DD the group says it paid on; null when the email does not say (the caller uses the email's date). */
  paidDay: string | null;
  lines: RemittanceLine[];
};

/** The email facts a parser reads. `body` is plain text (HTML already flattened). */
export type RemittanceEmail = { senders: readonly string[]; subject: string; body: string; /** The email's own day, YYYY-MM-DD. */ day: string };

export type RemittanceParser = {
  group: string;
  /** Sender domains (a subdomain also counts). */
  domains: readonly string[];
  /** The group's parse of one email, or null when it is not a payment email. */
  parse: (e: RemittanceEmail) => Omit<RemittanceParse, 'group'> | null;
};

const onDomain = (senders: readonly string[], domains: readonly string[]) =>
  senders.some(a => { const d = a.slice(a.lastIndexOf('@') + 1).trim().toLowerCase(); return domains.some(x => d === x || d.endsWith(`.${x}`)); });

/** The first parser whose sender matches and which reads the email as a payment with a total; null otherwise. */
export function parseRemittanceEmail(parsers: readonly RemittanceParser[], e: RemittanceEmail): RemittanceParse | null {
  for (const p of parsers) {
    if (!onDomain(e.senders, p.domains)) continue;
    const r = p.parse(e);
    if (r && r.totalCents > 0) return { group: p.group, ...r };
  }
  return null;
}

// ---- shared text helpers (a group's parser composes these) ----

const MONEY = /\$\s*(-?[\d,]+(?:\.\d{1,2})?)/g;
/** Cents of every dollar amount in the text, in order. */
export function moneyCents(text: string): number[] {
  return [...text.matchAll(MONEY)].map(m => Math.round(parseFloat(m[1].replace(/,/g, '')) * 100)).filter(n => Number.isFinite(n));
}

/** A day (YYYY-MM-DD) from text like 2026-07-09, 07/09/2026 or "July 9, 2026"; null otherwise. */
export function dayIn(text: string): string | null {
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const w = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i);
  return w ? `${w[3]}-${String(months.indexOf(w[1].toLowerCase()) + 1).padStart(2, '0')}-${w[2].padStart(2, '0')}` : null;
}

// A carrier tracking number: UPS 1Z..., Amazon TBA..., S10 (two letters, nine digits, two letters), or a long digit run (FedEx/USPS).
const TRACKING = /\b(1Z[0-9A-Z]{16}|TBA\d{9,15}|[A-Z]{2}\d{9}[A-Z]{2}|\d{12,34})\b/gi;
/** The tracking numbers in a line, normalized (upper case, letters and digits only), de-duplicated. */
export function trackingIn(text: string): string[] {
  return [...new Set([...text.matchAll(TRACKING)].map(m => normTracking(m[1])))];
}

/**
 * Pairs tracking numbers with amounts. A line holding one tracking number and a dollar amount is a pair (the last amount is the
 * value, so "qty 2 ... $9.00" style rows read right). A tracking number alone on a line takes the next line's amount when that
 * line holds no tracking number (label-per-line layouts). A line with several tracking numbers is not guessed. Lines about
 * totals are never pairs. The same tracking number twice adds up.
 */
export function pairTrackingAmounts(body: string): RemittanceLine[] {
  const out = new Map<string, number>();
  let pending: string | null = null, age = 0;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const trk = trackingIn(line);
    const money = moneyCents(line);
    if (/\b(?:sub)?total\b/i.test(line) || (/\bfees?\b|\bshipping\b/i.test(line) && !trk.length)) { pending = null; continue; }
    if (trk.length === 1 && money.length) { out.set(trk[0], (out.get(trk[0]) ?? 0) + money[money.length - 1]); pending = null; continue; }
    if (trk.length === 1) { pending = trk[0]; age = 0; continue; }
    if (trk.length > 1) { pending = null; continue; }
    if (pending && money.length && ++age <= 3) { out.set(pending, (out.get(pending) ?? 0) + money[0]); pending = null; continue; }
    if (pending && ++age > 3) pending = null;
  }
  return [...out].map(([tracking, amountCents]) => ({ tracking, amountCents }));
}
