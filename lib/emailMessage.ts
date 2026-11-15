import { simpleParser } from 'mailparser';
import { parseOrderEmail, isOrderEmail, htmlToText, emailAddresses, type EmailKind, type EmailPlatform } from './emailParse.ts';

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
  const text = parsed.text || (typeof parsed.html === 'string' ? htmlToText(parsed.html) : '');
  const p = parseOrderEmail({
    subject: parsed.subject ?? '',
    from: parsed.from?.text ?? '',
    text,
    headerLines: (parsed.headerLines ?? []).map(h => ({ key: h.key, line: h.line })),
  });
  if (opts.shared && !isOrderEmail(p)) return null;

  const recipients = [...p.recipients];
  for (const a of emailAddresses(opts.envelopeTo).reverse()) {
    if (!recipients.includes(a)) recipients.unshift(a);
  }

  return {
    uid: id,
    messageId: parsed.messageId ?? String(id),
    subject: p.subject,
    from: p.from,
    date: parsed.date?.toISOString() ?? new Date().toISOString(),
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
