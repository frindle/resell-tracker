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

export type EgiftImage = { bytes: Buffer; mimeType: string; ext: string };
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/**
 * The optional card image on a scraped card: body.image is base64 (a data: URL prefix is tolerated).
 * Accepted only when the bytes really are a PNG, JPEG or WebP and fit the size cap; anything else is
 * ignored (the card itself is still saved), never an error.
 */
export function parseEgiftImage(body: unknown): EgiftImage | null {
  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>).image : null;
  if (typeof raw !== 'string' || raw.length < 16 || raw.length > MAX_IMAGE_BYTES * 1.4) return null;
  const b64 = raw.replace(/^data:[^,]*,/, '');
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length < 8 || bytes.length > MAX_IMAGE_BYTES) return null;
  if (bytes[0] === 0x89 && bytes.subarray(1, 4).toString('latin1') === 'PNG') return { bytes, mimeType: 'image/png', ext: '.png' };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { bytes, mimeType: 'image/jpeg', ext: '.jpg' };
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return { bytes, mimeType: 'image/webp', ext: '.webp' };
  return null;
}
