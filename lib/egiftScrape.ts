// Fetching an order's Costco eGift cards from the delivery site. The site
// can only be read in a real browser session, so the tracker queues a command
// for the browser extension (the sidecar has no driver for it). The command
// payload carries only the order id: the extension asks
// GET /api/extension/egift for the link and email, and saves each card it
// finds with POST /api/extension/egift. Nothing here is logged.

import { REVIEW_CODE_SOURCE, REVIEWED_CODE_SOURCE } from './giftCardReview.ts';

export const EGIFT_SCRAPE_COMMAND = 'SCRAPE_EGIFT';
/** The browser extension's poll identity (same as the Amazon commands). */
export const EGIFT_EXTENSION_TARGET = 'chrome';

/** Body the order page POSTs to /api/extension/commands. */
export function egiftScrapeCommand(orderId: number) {
  return { type: EGIFT_SCRAPE_COMMAND, targetBrowser: EGIFT_EXTENSION_TARGET, payload: { orderId } } as const;
}

/**
 * Why a scrape cannot start, or null when it can. The delivery site asks for
 * the address before it opens the order, so one must be known.
 */
export function egiftScrapeBlocker(s: { hasLink: boolean; hasEmail: boolean }): string | null {
  if (!s.hasLink) return 'Save the delivery link first.';
  if (!s.hasEmail) return 'Add the delivery email (below, or a default in Settings) first.';
  return null;
}

/** The server refuses to hand out the link and email unless a shared secret guards the route. */
export function egiftSecretConfigured(env: { EXTENSION_SHARED_SECRET?: string | undefined }): boolean {
  return !!env.EXTENSION_SHARED_SECRET;
}

export type EgiftCardData = {
  merchant: string;
  value: number;
  cardNumber: string;
  pin: string | null;
  codeSource: string;
};

const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\s+/g, '').slice(0, max) : '');

/** A card number with spaces and dashes removed, for comparing the same code typed two ways. */
export function normalizeCardNumber(v: string): string {
  return v.replace(/[\s-]+/g, '');
}

/**
 * One scraped card as the extension posts it: { cardNumber, pin?, merchant?, value? }.
 * A card whose merchant or value could not be read is still kept (the code is
 * real) but flagged for review with value 0, so it is never sold half-filled.
 * Returns null when there is no usable code.
 */
export function parseEgiftCard(body: unknown): EgiftCardData | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const cardNumber = clean(b.cardNumber, 64);
  if (cardNumber.length < 4) return null;
  const pin = clean(b.pin, 32) || null;
  const merchant = typeof b.merchant === 'string' ? b.merchant.trim().slice(0, 80) : '';
  const value = typeof b.value === 'number' && Number.isFinite(b.value) ? b.value : 0;
  if (merchant && value > 0 && value <= 10000) {
    return { merchant, value, cardNumber, pin, codeSource: REVIEWED_CODE_SOURCE };
  }
  return { merchant: 'eGift', value: 0, cardNumber, pin, codeSource: REVIEW_CODE_SOURCE };
}
