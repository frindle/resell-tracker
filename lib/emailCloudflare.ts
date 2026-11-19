import { parseRawOrderEmail, type ParsedEmailOrder } from './emailMessage.ts';

// Cloudflare Email Routing source: the order-inbox worker (workers/order-inbox)
// stores raw mail in KV and serves it over an authenticated HTTP API.

export type CloudflareCreds = { url: string; token: string };
type FetchFn = typeof fetch;

export type ListedMessage = { id: string; to: string; from: string; size: number; receivedAt: string };
type ListPage = { messages: ListedMessage[]; cursor: string | null; complete: boolean };

const MAX_PAGES = 50; // 5000 messages at 100 per page

function endpoint(creds: CloudflareCreds, path: string): string {
  return creds.url.replace(/\/+$/, '') + path;
}

function headers(creds: CloudflareCreds): HeadersInit {
  return { Authorization: `Bearer ${creds.token}` };
}

async function listPage(creds: CloudflareCreds, fetchFn: FetchFn, cursor: string | null, limit: number): Promise<ListPage> {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (cursor) qs.set('cursor', cursor);
  const res = await fetchFn(endpoint(creds, `/messages?${qs}`), { headers: headers(creds) });
  if (!res.ok) throw new Error(`Cloudflare inbox list failed: HTTP ${res.status}`);
  return (await res.json()) as ListPage;
}

/** Throws when the worker URL or pull token is wrong. */
export async function testCloudflare(creds: CloudflareCreds, fetchFn: FetchFn = fetch): Promise<void> {
  await listPage(creds, fetchFn, null, 1);
}

/**
 * Parsed messages by id. A message stays in the inbox until it is imported or
 * deleted, so a caller that polls passes the same cache each time and every
 * message is downloaded and parsed once. Null marks a message that is not an
 * order email. Ids no longer in the inbox are dropped from it.
 */
export type ParsedCache = Map<string, ParsedEmailOrder | null>;

/** Every message in the inbox (metadata only), following the worker's cursor. */
export async function listCloudflareMessages(creds: CloudflareCreds, fetchFn: FetchFn = fetch): Promise<ListedMessage[]> {
  const all: ListedMessage[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page: ListPage = await listPage(creds, fetchFn, cursor, 100);
    all.push(...page.messages);
    if (page.complete || !page.cursor) break;
    cursor = page.cursor;
  }
  return all;
}

/** One message's raw MIME, or null when it is gone or unreadable. */
export async function fetchCloudflareRaw(creds: CloudflareCreds, id: string, fetchFn: FetchFn = fetch): Promise<Buffer | null> {
  const res = await fetchFn(endpoint(creds, `/messages/${encodeURIComponent(id)}`), { headers: headers(creds) });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

export async function fetchCloudflareOrderEmails(
  creds: CloudflareCreds,
  since?: Date,
  opts: { limit?: number; fetchFn?: FetchFn; cache?: ParsedCache; bgReceipts?: boolean } = {},
): Promise<ParsedEmailOrder[]> {
  const fetchFn = opts.fetchFn ?? fetch;
  const all = await listCloudflareMessages(creds, fetchFn);

  const sinceMs = since ? since.getTime() : -Infinity;
  const wanted = all
    .filter(m => !m.receivedAt || new Date(m.receivedAt).getTime() >= sinceMs)
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
    .slice(-(opts.limit ?? 200));

  const cache = opts.cache;
  if (cache) {
    const listed = new Set(all.map(m => m.id));
    for (const id of cache.keys()) if (!listed.has(id)) cache.delete(id);
  }

  const results: ParsedEmailOrder[] = [];
  const queue: ListedMessage[] = [];
  for (const m of wanted) {
    if (cache?.has(m.id)) {
      const row = cache.get(m.id);
      if (row) results.push(row);
    } else {
      queue.push(m);
    }
  }
  const worker = async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      try {
        const raw = await fetchCloudflareRaw(creds, m.id, fetchFn);
        if (!raw) continue;
        const row = await parseRawOrderEmail(raw, m.id, { shared: true, envelopeTo: m.to, bgReceipts: opts.bgReceipts });
        cache?.set(m.id, row);
        if (row) results.push(row);
      } catch {
        // skip malformed or unreachable messages
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, queue.length) }, worker));

  return results.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

export async function deleteCloudflareMessages(creds: CloudflareCreds, ids: string[], fetchFn: FetchFn = fetch): Promise<void> {
  for (const id of ids) {
    const res = await fetchFn(endpoint(creds, `/messages/${encodeURIComponent(id)}`), { method: 'DELETE', headers: headers(creds) });
    if (!res.ok && res.status !== 404) throw new Error(`Cloudflare inbox delete failed: HTTP ${res.status}`);
  }
}
