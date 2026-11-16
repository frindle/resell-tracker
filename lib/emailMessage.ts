import { simpleParser } from 'mailparser';
import { isBigSkySender } from './bigskyAutoLoginCore.ts';
import { parseOrderEmail, isOrderEmail, htmlToText, emailAddresses, parseHeaderDate, type EmailKind, type EmailPlatform, type ParsedOrderFields } from './emailParse.ts';

// Gmail messages are identified by numeric IMAP UID, Cloudflare ones by the
// worker's string key.
export type MessageId = number | string;

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
  const plain = parsed.text ?? '';
  const htmlText = typeof parsed.html === 'string' ? htmlToText(parsed.html) : '';
  let p = parse(plain || htmlText);
  // Some clients (Tuta) forward with the HTML flattened into a few lines of
  // text/plain; read the HTML too and keep whichever finds more of the order.
  if (plain && htmlText) {
    const fromHtml = parse(htmlText);
    if (found(fromHtml) > found(p)) p = fromHtml;
  }
  if (opts.shared && !isOrderEmail(p)) return null;
  // BigSky (a buying group) never sends retailer orders. Its sign-in code
  // emails are read by lib/bigskyAutoLogin.ts; none of its mail is imported.
  if (opts.shared && isBigSkySender(p.senders)) return null;

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
  };
}
