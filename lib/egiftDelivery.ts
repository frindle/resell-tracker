// Reading a Costco eGift delivery email: the per-order delivery link, the Costco order number it
// belongs to, and the address it was sent to when the email shows one. Pure, so it is testable with
// synthetic emails. The link and the address are secrets / personal data: callers keep them in memory
// only (see lib/egiftIngest.ts) and never log them.

import { parseCostcoDeliveryLink } from './egiftLinkParse.ts';
import { normalizeEgiftEmail } from './egiftEmail.ts';

export type EgiftDelivery = {
  /**
   * Normalised https://www.memberedelivery.com/?login=... link (a secret), or null when the email
   * only carries click-tracking links (see trackedLinks).
   */
  link: string | null;
  /**
   * Click-tracking links (https://link.memberedelivery.com/ls/click?upn=...) that redirect to the
   * delivery link. Some delivery emails ("Your E-Delivery Order #...") carry only these. They are
   * secrets too: lib/egiftLinkResolve.ts follows them to the real link, and only when the order still
   * has no link (following one counts as a click).
   */
  trackedLinks?: readonly string[];
  /** Costco order number as printed, '' when the email does not show one. */
  orderNumber: string;
  /** The address the cards were sent to, when the email names it (personal data). */
  recipient: string | null;
};

const decodeAmp = (s: string) => s.replace(/&amp;/gi, '&');

/** Every candidate URL in the html (hrefs) and the text, in order, de-duplicated. */
function candidateUrls(html: string, text: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) out.push(decodeAmp(m[1] ?? m[2] ?? ''));
  for (const m of `${text}\n${html}`.matchAll(/https?:\/\/[^\s"'<>)\]]+/gi)) out.push(decodeAmp(m[0]).replace(/[.,;]+$/, ''));
  return [...new Set(out)];
}

/** The first valid memberedelivery.com delivery link, or null. */
export function findDeliveryLink(html: string, text: string): string | null {
  for (const u of candidateUrls(html, text)) {
    if (!/memberedelivery\.com/i.test(u)) continue;
    const p = parseCostcoDeliveryLink(u);
    if (p.ok) return p.normalized;
  }
  return null;
}

/** Hosts of a click-tracking hop: memberedelivery.com subdomains other than www, and SendGrid. */
export function isTrackingHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'www.memberedelivery.com') return false;
  return h.endsWith('.memberedelivery.com') || h === 'sendgrid.net' || h.endsWith('.sendgrid.net');
}

// A tracked link is followed for real, so never one that could change a setting (unsubscribe and the
// like): judged by the anchor text in the html, or by the plain-text line the link sits on.
const NOT_DELIVERY_RE = /unsubscribe|opt[\s-]?out|preferences|privacy|terms|policy|feedback|survey/i;

function linkContexts(html: string, text: string): Map<string, string> {
  const ctx = new Map<string, string>();
  const add = (u: string, c: string) => ctx.set(u, `${ctx.get(u) ?? ''} ${c}`);
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(m[1]);
    if (!href) continue;
    const attrs = m[1].replace(/href\s*=\s*(?:"[^"]*"|'[^']*')/i, ' ');
    add(decodeAmp(href[1] ?? href[2] ?? ''), `${m[2].replace(/<[^>]*>/g, ' ')} ${attrs}`);
  }
  for (const line of text.split(/\r?\n/)) {
    for (const m of line.matchAll(/https?:\/\/[^\s"'<>)\]]+/gi)) add(decodeAmp(m[0]).replace(/[.,;]+$/, ''), line);
  }
  return ctx;
}

/**
 * Every https click-tracking link (/ls/click or /wf/click on a tracking host) whose anchor text or
 * text line does not look like unsubscribe / preferences / policy, at most 6, in order.
 */
export function findTrackedDeliveryLinks(html: string, text: string): string[] {
  const out: string[] = [];
  const ctx = linkContexts(html, text);
  for (const u of candidateUrls(html, text)) {
    if (NOT_DELIVERY_RE.test(ctx.get(u) ?? '')) continue;
    let url: URL;
    try { url = new URL(u); } catch { continue; }
    if (url.protocol !== 'https:' || url.username || url.password) continue;
    if (!isTrackingHost(url.hostname)) continue;
    if (!/^\/(?:ls|wf)\/click\b/i.test(url.pathname)) continue;
    out.push(url.toString());
    if (out.length >= 6) break;
  }
  return out;
}

const ORDER_RE = /\border\s*(?:number|no\.?|num\.?|#)\s*[:#]?\s*#?\s*(\d[\d-]{5,24})/i;

/** The order number printed after "Order #" / "Order Number:", or ''. */
export function findOrderNumber(text: string): string {
  const m = ORDER_RE.exec(text);
  return m ? m[1].replace(/-+$/, '') : '';
}

const SENT_TO_RE = /\b(?:sent|delivered|emailed)\s+to\s*:?\s*<?([^\s<>"',;()]+@[^\s<>"',;()]+\.[^\s<>"',;()]+)/i;

/** An address the email says the cards went to ("sent to ..."), or null. */
export function findRecipient(text: string): string | null {
  const m = SENT_TO_RE.exec(text);
  return m ? normalizeEgiftEmail(m[1].replace(/[.>]+$/, '')) : null;
}

export function extractEgiftDelivery(input: {
  html?: string;
  text?: string;
  /** Costco order number the generic order parser found, used when the body has no "Order #" line. */
  parsedOrderNumber?: string;
  /**
   * The address the delivery email was sent to: the order-inbox envelope recipient, else the To
   * header. Costco sends the cards to the address the order was placed with, and that is the inbox
   * address the delivery page asks for, so it wins over the body's "sent to" line.
   */
  toAddress?: string | null;
}): EgiftDelivery | null {
  const html = input.html ?? '';
  const text = input.text ?? '';
  const link = findDeliveryLink(html, text);
  // Only from a memberedelivery.com email body: a tracked link alone is not proof of a delivery email
  // unless it points at the delivery site's own tracking host.
  const trackedLinks = link ? [] : findTrackedDeliveryLinks(html, text).filter(u => new URL(u).hostname.toLowerCase().endsWith('.memberedelivery.com'));
  if (!link && !trackedLinks.length) return null;
  const orderNumber = findOrderNumber(text) || (input.parsedOrderNumber ?? '').trim();
  const recipient = normalizeEgiftEmail(input.toAddress ?? null) ?? findRecipient(text);
  return link ? { link, orderNumber, recipient } : { link: null, trackedLinks, orderNumber, recipient };
}
