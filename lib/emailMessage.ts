import { simpleParser } from 'mailparser';
import { parseOrderEmail, isOrderEmail, htmlToText, plainTextWithMarkup, emailAddresses, parseHeaderDate, orderNumberFromLinks, trackingFromLinks, carriesOrderTracking, type CancelInfo, type EmailKind, type EmailPlatform, type ParsedOrderFields } from './emailParse.ts';

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
};

// How much of an order a parse found; picks between the text and HTML parts.
function found(p: ParsedOrderFields): number {
  return (p.orderNumber ? 4 : 0) + (p.cost > 0 ? 2 : 0) + (p.trackingNumbers.length ? 2 : 0)
    + (p.itemDescription ? 1 : 0) + (p.shippingAddress ? 1 : 0) + (p.platform !== 'Unknown' ? 1 : 0);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Parse one raw MIME message into an order row. `envelopeTo` (the SMTP
 * recipient, when the source knows it) is added to `recipients` ahead of the
 * header-derived ones. Returns null when `shared` and it is not order mail.
 */
export async function parseRawOrderEmail(
  raw: Buffer | Uint8Array | string,
  id: MessageId,
  opts: { shared?: boolean; envelopeTo?: string } = {},
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
  let p = parse(plain || htmlText);
  // Some clients (Tuta) forward with the HTML flattened into a few lines of
  // text/plain; read the HTML too and keep whichever finds more of the order.
  if (plain && htmlText) {
    const fromHtml = parse(htmlText);
    if (found(fromHtml) > found(p)) p = fromHtml;
  }
  // HTML-to-text drops links, and some fields only live in them.
  const html = typeof parsed.html === 'string' ? parsed.html : '';
  if (html) {
    if (!p.orderNumber) p = { ...p, orderNumber: orderNumberFromLinks(html) };
    if (carriesOrderTracking(p.kind)) {
      const more = trackingFromLinks(html).filter(t => !p.trackingNumbers.includes(t));
      if (more.length) p = { ...p, trackingNumbers: [...p.trackingNumbers, ...more] };
    }
  }
  // Buying groups (BigSky, BuyingGroup.com, BFMR) never send retailer orders,
  // but their mail can name a store, an order number and a cancel, so it is
  // never imported and never alerted on; it stays in the inbox. BigSky's
  // sign-in codes are read there by lib/bigskyAutoLogin.ts.
  if (opts.shared && isGroupSender(p.senders)) return null;
  if (opts.shared && !isOrderEmail(p)) return null;

  // A forward's own Date is when it was forwarded; the retailer's is in the
  // forwarded header block. Ignore one that is later than the forward.
  const inner = p.date ? parseHeaderDate(p.date) : null;
  const outer = parsed.date;
  const date = inner && (!outer || inner.getTime() <= outer.getTime() + DAY_MS) ? inner : outer;

  const recipients = [...p.recipients];
  for (const a of emailAddresses(opts.envelopeTo).reverse()) {
    if (!recipients.includes(a)) recipients.unshift(a);
  }

  return {
    uid: id,
    messageId: parsed.messageId ?? String(id),
    subject: p.subject,
    from: p.from,
    date: date?.toISOString() ?? new Date().toISOString(),
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
    rawSnippet: p.body.replace(/\s+/g, ' ').trim().slice(0, 300),
    ...(p.cancel ? { cancel: p.cancel } : {}),
  };
}
