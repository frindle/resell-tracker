import { simpleParser } from 'mailparser';
import { parseBgReceipt, type BgReceipt } from './bgReceiptEmail.ts';
import type { PayPalReceipt } from './paypalReceipt.ts';
import { classifyNonOrder, parseBgExpiry, type NoiseClass, type BgExpiry } from './emailNoise.ts';
import { parseBgPriceChange, type BgPriceChange } from './bgPriceChange.ts';
import { parseWalmartReturnLabel, type WalmartReturnLabel } from './walmartReturnLabel.ts';
import { parseExpectedDelivery } from './expectedDelivery.ts';
import { chooseEmailDate, emailDeliveredAt, type DateSource } from './orderedAt.ts';
import { deliveryRecipient, extractEgiftDelivery, type EgiftDelivery } from './egiftDelivery.ts';
import { parseOrderEmail, isOrderEmail, htmlToText, plainTextWithMarkup, emailAddresses, parseHeaderDate, orderNumberFromLinks, trackingFromLinks, carriesOrderTracking, itemFromImageAlts, type ExtraOrder, type CancelInfo, type DelayInfo, type EmailKind, type EmailPlatform, type ParsedOrderFields } from './emailParse.ts';

// Gmail messages are identified by numeric IMAP UID, Cloudflare ones by the
// worker's string key.
export type MessageId = number | string;

const GROUP_SENDER = /@(?:[a-z0-9-]+\.)*(?:bigskybuyers|buyinggroup|bfmr)\.com$/i;

/** True when any address is a buying group's (or a subdomain's). */
export function isGroupSender(addresses: readonly string[]): boolean {
  return addresses.some(a => GROUP_SENDER.test(a.trim()));
}

export type ParsedEmailOrder = {
  uid: MessageId;
  messageId: string;
  subject: string; // the retailer's subject, unwrapped from a forward
  from: string; // the retailer's From, unwrapped from a forward
  date: string;
  /** The message carried no Date: `date` is the time it was read, which changes on every re-read. */
  undated?: boolean;
  /** Where `date` came from; only 'direct' and 'forwarded-original' are the retailer's own time (lib/orderedAt.ts). */
  dateSource?: DateSource;
  platform: EmailPlatform;
  kind: EmailKind;
  forwarded: boolean;
  orderNumber: string;
  itemDescription: string;
  cost: number;
  shippingAddress: string;
  trackingNumbers: string[];
  recipients: string[]; // addresses it was sent to or forwarded from (routing)
  senders: string[]; // the retailer's address (routing fallback)
  rawSnippet: string; // first ~300 chars of plain text for display
  cancel?: CancelInfo; // cancellation emails: amount and whether the whole order went
  /** The merchant's expected delivery days (YYYY-MM-DD) from an Amazon / Walmart order or shipping email, or any delay notice. Read relative to `date`. */
  expected?: { start: string; end: string };
  delay?: DelayInfo; // delay notices: the new estimate when the email gives one
  extraOrders?: ExtraOrder[]; // a shipping/delivery email covering more than one order: the others
  noise?: NoiseClass; // positively not an order (only when the caller asks): safe to delete
  bgExpiry?: BgExpiry; // a BuyingGroup deal-expired notice (only when the caller asks for them)
  bgPriceChange?: BgPriceChange; // a BuyingGroup "Commitment Price Change Scheduled" notice (same)
  bgReceipt?: BgReceipt; // a BuyingGroup.com receipt email (only when the caller asks for them)
  payment?: PayPalReceipt; // PayPal payment receipts (kind 'payment'): merchant, amount, card, transaction id
  orderLink?: string; // Amazon order/shipping emails: a safe link to the order's detail page (lib/amazonOrderLink.ts)
  merchandiseSubtotal?: number; // Costco order emails: merchandise after discounts, before tax and shipping
  returnLabel?: WalmartReturnLabel; // a Walmart return-label email: the return's FedEx tracking (lib/walmartReturnLabelDb.ts)
  // Costco eGift delivery emails: the secret delivery link. NON-ENUMERABLE on purpose, so it never
  // reaches JSON.stringify (the /api/email/sync response) or a spread copy. Read only by lib/egiftIngest.
  readonly egiftDelivery?: EgiftDelivery;
};

const EGIFT_URL_RE = /https?:\/\/[^\s)>"'\]]*memberedelivery\.com[^\s)>"'\]]*/gi;

function withEgiftDelivery<T extends object>(row: T, d: EgiftDelivery | null): T {
  if (d) Object.defineProperty(row, 'egiftDelivery', { value: d, enumerable: false });
  return row;
}

// How much of an order a parse found; picks between the text and HTML parts.
function found(p: ParsedOrderFields): number {
  return (p.orderNumber ? 4 : 0) + (p.cost > 0 ? 2 : 0) + (p.trackingNumbers.length ? 2 : 0)
    + (p.itemDescription ? 1 : 0) + (p.shippingAddress ? 1 : 0) + (p.platform !== 'Unknown' ? 1 : 0);
}

/**
 * Parse one raw MIME message into an order row. `envelopeTo` (the SMTP
 * recipient, when the source knows it) is added to `recipients` ahead of the
 * header-derived ones. Returns null when `shared` and it is not order mail.
 */
export async function parseRawOrderEmail(
  raw: Buffer | Uint8Array | string,
  id: MessageId,
  opts: { shared?: boolean; envelopeTo?: string; bgReceipts?: boolean; noise?: boolean } = {},
): Promise<ParsedEmailOrder | null> {
  const parsed = await simpleParser(typeof raw === 'string' || Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
  const parse = (text: string) => parseOrderEmail({
    subject: parsed.subject ?? '',
    from: parsed.from?.text ?? '',
    text,
    headerLines: (parsed.headerLines ?? []).map(h => ({ key: h.key, line: h.line })),
  });
  const plain = plainTextWithMarkup(parsed.text ?? '');
  const htmlText = typeof parsed.html === 'string' ? htmlToText(parsed.html) : '';
  const html = typeof parsed.html === 'string' ? parsed.html : '';
  let p = parse(plain || htmlText);
  // Some clients (Tuta) forward with the HTML flattened into a few lines of
  // text/plain; read the HTML too and keep whichever finds more of the order.
  if (plain && htmlText) {
    const fromHtml = parse(htmlText);
    // A split parse carries no tracking, so it scores lower; it still wins, or
    // the other part's tracking would all land on the first order.
    const splitHtml = !!fromHtml.extraOrders?.length;
    const splitPlain = !!p.extraOrders?.length;
    if (splitHtml || splitPlain ? splitHtml && (!splitPlain || found(fromHtml) > found(p)) : found(fromHtml) > found(p)) p = fromHtml;
  }
  // Walmart's product titles are only in the images' alt text. A cancellation
  // subject cuts the title short, so the full one wins there.
  if (html && p.platform === 'Walmart' && (!p.itemDescription || p.kind === 'cancelled' || /(?:\.{3}|…)/.test(p.subject))) {
    const fromAlts = itemFromImageAlts(html);
    if (fromAlts) p = { ...p, itemDescription: fromAlts };
  }
  // HTML-to-text drops links, and some fields only live in them.
  if (html) {
    if (!p.orderNumber) p = { ...p, orderNumber: orderNumberFromLinks(html) };
    // Not for a multi-order email: a link may belong to any of its orders.
    if (carriesOrderTracking(p.kind) && !p.extraOrders?.length) {
      const more = trackingFromLinks(html).filter(t => !p.trackingNumbers.includes(t));
      if (more.length) p = { ...p, trackingNumbers: [...p.trackingNumbers, ...more] };
    }
  }
  // Buying groups (BigSky, BuyingGroup.com, BFMR) never send retailer orders,
  // but their mail can name a store, an order number and a cancel, so it is
  // never imported and never alerted on; it stays in the inbox. BigSky's
  // sign-in codes are read there by lib/bigskyAutoLogin.ts.
  const bare = (platform: EmailPlatform): ParsedEmailOrder => ({
    uid: id, messageId: parsed.messageId ?? String(id), subject: p.subject, from: p.from,
    date: (parsed.date ?? new Date()).toISOString(), platform, kind: 'other', forwarded: p.forwarded,
    orderNumber: '', itemDescription: '', cost: 0, shippingAddress: '', trackingNumbers: [],
    recipients: [...p.recipients], senders: p.senders, rawSnippet: '',
  });
  // Mail the parser positively knows is not an order. Nothing of its body is kept.
  if (opts.shared && opts.noise) {
    const noise = classifyNonOrder(p.senders, p.subject);
    if (noise) return { ...bare(p.platform), noise };
  }
  if (opts.shared && isGroupSender(p.senders)) {
    // BuyingGroup receipts are handed to the receipt sync, never imported.
    const bgReceipt = opts.bgReceipts ? parseBgReceipt(p.subject, p.body) : null;
    if (bgReceipt) return { ...bare('BuyingGroup'), bgReceipt };
    const bgExpiry = opts.bgReceipts ? parseBgExpiry(p.subject, p.body) : null;
    if (bgExpiry) return { ...bare('BuyingGroup'), bgExpiry };
    const bgPriceChange = opts.bgReceipts ? parseBgPriceChange(p.subject, p.body) : null;
    if (bgPriceChange) return { ...bare('BuyingGroup'), bgPriceChange };
    return null;
  }
  // A Costco eGift delivery email carries the per-order delivery link. The address Costco sent it to
  // (a forward's original To, else the To header) is the address the delivery page asks for; the
  // worker's envelope recipient is the tracker's inbox, used only when nothing else names one.
  const inbox = emailAddresses(opts.envelopeTo);
  const headerTo = (Array.isArray(parsed.to) ? parsed.to : parsed.to ? [parsed.to] : [])
    .flatMap(t => t.value.map(v => v.address ?? ''));
  const egift = extractEgiftDelivery({
    html, text: `${plain}\n${htmlText}`, parsedOrderNumber: p.orderNumber,
    toAddress: deliveryRecipient([...(p.forwardedTo ?? []), ...headerTo], inbox),
    inbox,
  });
  const returnLabel = parseWalmartReturnLabel({ platform: p.platform, subject: p.subject, body: p.body, html, orderNumber: p.orderNumber });
  if (opts.shared && !isOrderEmail(p) && !egift) return null;

  // A forward's own Date is when it was forwarded; the retailer's is in the
  // forwarded header block. Ignore one that is later than the forward.
  const { date, source: dateSource } = chooseEmailDate({
    outer: parsed.date,
    inner: p.date,
    innerParsed: p.date ? parseHeaderDate(p.date) : null,
    forwarded: p.forwarded || /^\s*(?:(?:fwd?|fw)\s*:\s*)+/i.test(parsed.subject ?? ''),
  });

  const recipients = [...p.recipients];
  for (const a of emailAddresses(opts.envelopeTo).reverse()) {
    if (!recipients.includes(a)) recipients.unshift(a);
  }

  // One order's expectation only: an email covering several orders does not say which package is whose.
  const expectedRange = date && !p.extraOrders?.length && (p.kind === 'delayed' || ((p.kind === 'ordered' || p.kind === 'shipped') && (p.platform === 'Amazon' || p.platform === 'Walmart')))
    ? parseExpectedDelivery(p.body, date) : null;
  const deliveredAt = egift && date ? emailDeliveredAt({ date: date.toISOString(), dateSource }) : null;
  return withEgiftDelivery({
    uid: id,
    messageId: parsed.messageId ?? String(id),
    subject: p.subject,
    from: p.from,
    date: date?.toISOString() ?? new Date().toISOString(),
    ...(date ? { dateSource } : { undated: true }),
    platform: p.platform,
    kind: p.kind,
    forwarded: p.forwarded,
    orderNumber: p.orderNumber,
    itemDescription: p.itemDescription,
    cost: p.cost,
    shippingAddress: p.shippingAddress,
    trackingNumbers: p.trackingNumbers,
    recipients,
    senders: p.senders,
    // The delivery link is a secret and this snippet goes to the browser: cut it out before slicing.
    rawSnippet: p.body.replace(EGIFT_URL_RE, '[eGift link]').replace(/\s+/g, ' ').trim().slice(0, 300),
    ...(p.cancel ? { cancel: p.cancel } : {}),
    ...(p.delay ? { delay: p.delay } : {}),
    ...(expectedRange ? { expected: { start: expectedRange.start.toISOString().slice(0, 10), end: expectedRange.end.toISOString().slice(0, 10) } } : {}),
    ...(p.extraOrders?.length ? { extraOrders: p.extraOrders } : {}),
    ...(p.payment ? { payment: p.payment } : {}),
    ...(p.orderLink ? { orderLink: p.orderLink } : {}),
    ...(p.merchandiseSubtotal != null ? { merchandiseSubtotal: p.merchandiseSubtotal } : {}),
    ...(returnLabel ? { returnLabel } : {}),
  }, egift ? { ...egift, ...(deliveredAt ? { deliveredAt } : {}) } : null);
}
