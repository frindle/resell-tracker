// Reading a Costco eGift delivery email: the per-order delivery link, the Costco order number it
// belongs to, and the address it was sent to when the email shows one. Pure, so it is testable with
// synthetic emails. The link and the address are secrets / personal data: callers keep them in memory
// only (see lib/egiftIngest.ts) and never log them.

import { parseCostcoDeliveryLink } from './egiftLinkParse.ts';
import { normalizeEgiftEmail } from './egiftEmail.ts';

export type EgiftDelivery = {
  /** Normalised https://www.memberedelivery.com/?login=... link (a secret). */
  link: string;
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
  if (!link) return null;
  const orderNumber = findOrderNumber(text) || (input.parsedOrderNumber ?? '').trim();
  const recipient = normalizeEgiftEmail(input.toAddress ?? null) ?? findRecipient(text);
  return { link, orderNumber, recipient };
}
