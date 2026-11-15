import { parseRawOrderEmail, type ParsedEmailOrder } from './emailMessage.ts';

// Cloudflare Email Routing source: the order-inbox worker (workers/order-inbox)
// stores raw mail in KV and serves it over an authenticated HTTP API.

export type CloudflareCreds = { url: string; token: string };
type FetchFn = typeof fetch;

type ListedMessage = { id: string; to: string; from: string; size: number; receivedAt: string };
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

export async function fetchCloudflareOrderEmails(
  creds: CloudflareCreds,
  since?: Date,
  opts: { limit?: number; fetchFn?: FetchFn } = {},
): Promise<ParsedEmailOrder[]> {
  const fetchFn = opts.fetchFn ?? fetch;
  const all: ListedMessage[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page: ListPage = await listPage(creds, fetchFn, cursor, 100);
    all.push(...page.messages);
    if (page.complete || !page.cursor) break;
    cursor = page.cursor;
  }

  const sinceMs = since ? since.getTime() : -Infinity;
  const wanted = all
    .filter(m => !m.receivedAt || new Date(m.receivedAt).getTime() >= sinceMs)
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
    .slice(-(opts.limit ?? 200));

  const results: ParsedEmailOrder[] = [];
  const queue = [...wanted];
  const worker = async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      try {
        const res = await fetchFn(endpoint(creds, `/messages/${encodeURIComponent(m.id)}`), { headers: headers(creds) });
        if (!res.ok) continue;
        const raw = Buffer.from(await res.arrayBuffer());
        const row = await parseRawOrderEmail(raw, m.id, { shared: true, envelopeTo: m.to });
        if (row) results.push(row);
      } catch {
        // skip malformed or unreachable messages
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, wanted.length) }, worker));

  return results.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

export async function deleteCloudflareMessages(creds: CloudflareCreds, ids: string[], fetchFn: FetchFn = fetch): Promise<void> {
  for (const id of ids) {
    const res = await fetchFn(endpoint(creds, `/messages/${encodeURIComponent(id)}`), { method: 'DELETE', headers: headers(creds) });
    if (!res.ok && res.status !== 404) throw new Error(`Cloudflare inbox delete failed: HTTP ${res.status}`);
  }
}
