import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

export type EmailCredentials = { address: string; appPassword: string };

export type ParsedEmailOrder = {
  uid: number;
  messageId: string;
  subject: string;
  from: string;
  date: string;
  platform: 'Amazon' | 'Walmart' | 'BuyingGroup' | 'Unknown';
  orderNumber: string;
  itemDescription: string;
  cost: number;
  shippingAddress: string;
  rawSnippet: string; // first ~300 chars of plain text for display
};

// ---------------------------------------------------------------------------
// Platform detection from sender / subject
// ---------------------------------------------------------------------------

function detectPlatform(from: string, subject: string): ParsedEmailOrder['platform'] {
  const f = from.toLowerCase();
  const s = subject.toLowerCase();
  if (f.includes('amazon') || s.includes('amazon')) return 'Amazon';
  if (f.includes('walmart') || s.includes('walmart')) return 'Walmart';
  if (f.includes('buyinggroup') || f.includes('buying group') || s.includes('buying group')) return 'BuyingGroup';
  return 'Unknown';
}

// ---------------------------------------------------------------------------
// Extract order number from subject or body text
// ---------------------------------------------------------------------------

const ORDER_PATTERNS: [RegExp, string][] = [
  // Amazon: 123-1234567-1234567
  [/\b(\d{3}-\d{7}-\d{7})\b/, '$1'],
  // Walmart: 10+ digit number preceded by # or "order"
  [/(?:#|order\s*(?:number|#|no\.?)?[\s:]*)(\d{10,})/i, '$1'],
  // Generic fallback
  [/order\s*(?:id|number|#|no\.?)?[\s:#]*([A-Z0-9]{6,})/i, '$1'],
];

function extractOrderNumber(text: string): string {
  for (const [re] of ORDER_PATTERNS) {
    const m = text.match(re);
    if (m) return m[1];
  }
  return '';
}

// ---------------------------------------------------------------------------
// Extract dollar amount from text (first occurrence that looks like a total)
// ---------------------------------------------------------------------------

const COST_PATTERNS = [
  /(?:order\s+total|grand\s+total|total|amount)[^\d$]*\$?([\d,]+\.\d{2})/i,
  /\$\s*([\d,]+\.\d{2})/,
];

function extractCost(text: string): number {
  for (const re of COST_PATTERNS) {
    const m = text.match(re);
    if (m) return parseFloat(m[1].replace(/,/g, ''));
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Extract a plausible shipping address block
// ---------------------------------------------------------------------------

function extractShippingAddress(text: string): string {
  const m = text.match(/(?:ship(?:ping|ped)\s+to|deliver(?:y|ed)\s+to)[:\s]+([^\n]{5,}(?:\n[^\n]{3,}){0,3})/i);
  return m ? m[1].trim().replace(/\s*\n\s*/g, ', ') : '';
}

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
];

// ---------------------------------------------------------------------------
// Main sync function
// ---------------------------------------------------------------------------

export async function fetchOrderEmails(creds: EmailCredentials): Promise<ParsedEmailOrder[]> {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: creds.address, pass: creds.appPassword },
    logger: false,
  });

  await client.connect();
  const lock = await client.getMailboxLock('INBOX');

  try {
    // Search for any message from a known order sender OR with order keywords in subject
    const uids = await client.search({
      or: [
        ...SEARCH_FROM.map(addr => ({ from: addr })),
        { subject: 'order confirmation' },
        { subject: 'your order' },
        { subject: 'order has shipped' },
      ],
    }, { uid: true });

    if (!uids || !Array.isArray(uids) || uids.length === 0) return [];

    // Cap at 100 most recent to avoid hammering the API
    const slice = (uids as number[]).slice(-100);
    const results: ParsedEmailOrder[] = [];

    for await (const msg of client.fetch(slice.join(','), { source: true, uid: true }, { uid: true })) {
      try {
        if (!msg.source) continue;
        const parsed = await simpleParser(msg.source);
        const subject = parsed.subject ?? '';
        const from = parsed.from?.text ?? '';
        const text = parsed.text ?? '';
        const bodySearch = `${subject} ${text}`;

        const platform = detectPlatform(from, subject);
        const orderNumber = extractOrderNumber(bodySearch);
        const cost = extractCost(text);
        const shippingAddress = extractShippingAddress(text);
        const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 300);

        results.push({
          uid: msg.uid,
          messageId: parsed.messageId ?? String(msg.uid),
          subject,
          from,
          date: parsed.date?.toISOString() ?? new Date().toISOString(),
          platform,
          orderNumber,
          itemDescription: '',
          cost,
          shippingAddress,
          rawSnippet: snippet,
        });
      } catch {
        // skip malformed messages
      }
    }

    // Most recent first
    return results.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  } finally {
    lock.release();
    await client.logout();
  }
}

// ---------------------------------------------------------------------------
// Delete a message by UID (moves to Trash then expunges)
// ---------------------------------------------------------------------------

export async function deleteEmail(creds: EmailCredentials, uid: number): Promise<void> {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: creds.address, pass: creds.appPassword },
    logger: false,
  });

  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    // Gmail: add \Deleted flag + expunge, or move to [Gmail]/Trash
    await client.messageMove(String(uid), '[Gmail]/Trash', { uid: true });
  } finally {
    lock.release();
    await client.logout();
  }
}

// ---------------------------------------------------------------------------
// Delete multiple messages
// ---------------------------------------------------------------------------

export async function deleteEmails(creds: EmailCredentials, uids: number[]): Promise<void> {
  if (!uids.length) return;
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: creds.address, pass: creds.appPassword },
    logger: false,
  });

  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    await client.messageMove(uids.join(','), '[Gmail]/Trash', { uid: true });
  } finally {
    lock.release();
    await client.logout();
  }
}
