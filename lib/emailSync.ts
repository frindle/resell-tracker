import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { parseOrderEmail, isOrderEmail, htmlToText, type EmailKind, type EmailPlatform } from './emailParse';

export type EmailCredentials = { address: string; appPassword: string };

export type ParsedEmailOrder = {
  uid: number;
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

// ---------------------------------------------------------------------------
// Build the search criteria — match common order email senders
// ---------------------------------------------------------------------------

const SEARCH_FROM = [
  'auto-confirm@amazon.com',
  'shipment-tracking@amazon.com',
  'order-update@amazon.com',
  '@walmart.com',
  'buyinggroup.com',
  'noreply@buyinggroup.com',
  'costco.com',
];

function imapClient(creds: EmailCredentials) {
  return new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: creds.address, pass: creds.appPassword },
    logger: false,
  });
}

// ---------------------------------------------------------------------------
// Main sync function
// ---------------------------------------------------------------------------

/**
 * Order emails in the inbox, newest first.
 *
 * A personal inbox is searched for known retailer senders and order subjects.
 * The shared order inbox only holds order mail, much of it forwarded (so the
 * outer From is a person, not a retailer): every message since `since` is
 * read and kept when it names a known retailer or an order number.
 */
export async function fetchOrderEmails(
  creds: EmailCredentials,
  since?: Date,
  opts: { shared?: boolean; limit?: number } = {},
): Promise<ParsedEmailOrder[]> {
  const client = imapClient(creds);

  await client.connect();
  let lock: Awaited<ReturnType<typeof client.getMailboxLock>> | undefined;
  try {
    lock = await client.getMailboxLock('INBOX');
  } catch (e) {
    await client.logout().catch(() => {});
    throw e;
  }

  try {
    let criteria: Record<string, unknown>;
    if (opts.shared) {
      criteria = since ? { since } : { all: true };
    } else {
      // Any message from a known order sender OR with order keywords in subject
      criteria = {
        or: [
          ...SEARCH_FROM.map(addr => ({ from: addr })),
          { subject: 'order confirmation' },
          { subject: 'your order' },
          { subject: 'order has shipped' },
        ],
      };
      if (since) criteria.since = since;
    }
    const uids = await client.search(criteria, { uid: true });

    if (!uids || !Array.isArray(uids) || uids.length === 0) return [];

    // Cap to the most recent messages to avoid hammering the API
    const slice = (uids as number[]).slice(-(opts.limit ?? (opts.shared ? 200 : 100)));
    const results: ParsedEmailOrder[] = [];

    for await (const msg of client.fetch(slice.join(','), { source: true, uid: true }, { uid: true })) {
      try {
        if (!msg.source) continue;
        const parsed = await simpleParser(msg.source);
        const text = parsed.text || (typeof parsed.html === 'string' ? htmlToText(parsed.html) : '');
        const p = parseOrderEmail({
          subject: parsed.subject ?? '',
          from: parsed.from?.text ?? '',
          text,
          headerLines: (parsed.headerLines ?? []).map(h => ({ key: h.key, line: h.line })),
        });
        if (opts.shared && !isOrderEmail(p)) continue;

        results.push({
          uid: msg.uid,
          messageId: parsed.messageId ?? String(msg.uid),
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
          recipients: p.recipients,
          senders: p.senders,
          rawSnippet: p.body.replace(/\s+/g, ' ').trim().slice(0, 300),
        });
      } catch {
        // skip malformed messages
      }
    }

    // Most recent first
    return results.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  } finally {
    try { lock?.release(); } catch { /* ignore */ }
    await client.logout().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Delete a message by UID (moves to Trash then expunges)
// ---------------------------------------------------------------------------

export async function deleteEmail(creds: EmailCredentials, uid: number): Promise<void> {
  const client = imapClient(creds);

  await client.connect();
  let lock2: Awaited<ReturnType<typeof client.getMailboxLock>> | undefined;
  try {
    lock2 = await client.getMailboxLock('INBOX');
  } catch (e) {
    await client.logout().catch(() => {});
    throw e;
  }
  try {
    // Gmail: add \Deleted flag + expunge, or move to [Gmail]/Trash
    await client.messageMove(String(uid), '[Gmail]/Trash', { uid: true });
  } finally {
    try { lock2?.release(); } catch { /* ignore */ }
    await client.logout().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Delete multiple messages
// ---------------------------------------------------------------------------

export async function deleteEmails(creds: EmailCredentials, uids: number[]): Promise<void> {
  if (!uids.length) return;
  const client = imapClient(creds);

  await client.connect();
  let lock: Awaited<ReturnType<typeof client.getMailboxLock>> | undefined;
  try {
    lock = await client.getMailboxLock('INBOX');
  } catch (e) {
    await client.logout().catch(() => {});
    throw e;
  }
  try {
    await client.messageMove(uids.join(','), '[Gmail]/Trash', { uid: true });
  } finally {
    try { lock?.release(); } catch { /* ignore */ }
    await client.logout().catch(() => {});
  }
}
