import { listCloudflareMessages, fetchCloudflareRaw, type CloudflareCreds } from './emailCloudflare.ts';
import { parseRawOrderEmail, type ParsedEmailOrder } from './emailMessage.ts';

// One-time backfill of Costco eGift delivery links. The delivery email moves to the order-inbox
// worker's 7-day /archive once the tracker deletes it, and email sync never reads the archive, so a
// delivery email that arrived before the eGift ingest shipped left its order without a link. Re-read
// the archive through the same parser and hand the delivery emails to the normal ingest, which is
// idempotent per order (never overwrites a link, never queues a second scrape). Counts only in logs:
// the links and recipient addresses never leave memory.

export const EGIFT_BACKFILL_KEY = 'email_egift_backfill_done';

type Ingest = (emails: readonly { egiftDelivery?: ParsedEmailOrder['egiftDelivery'] }[]) => Promise<unknown>;

export type EgiftBackfillResult = { ok: boolean; listed: number; parsed: number; deliveries: number };

/**
 * Reads /archive and ingests every eGift delivery email in it. `ok` is false only when the archive
 * could not be listed (so the caller leaves the done mark unset and retries); one unreadable message
 * is skipped.
 */
export async function backfillEgiftFromArchive(
  cf: CloudflareCreds,
  ingest: Ingest,
  fetchFn: typeof fetch = fetch,
): Promise<EgiftBackfillResult> {
  const result: EgiftBackfillResult = { ok: true, listed: 0, parsed: 0, deliveries: 0 };
  let listed;
  try {
    listed = await listCloudflareMessages(cf, fetchFn, '/archive');
  } catch {
    return { ...result, ok: false };
  }
  result.listed = listed.length;
  const deliveries: ParsedEmailOrder[] = [];
  for (const m of listed) {
    try {
      const raw = await fetchCloudflareRaw(cf, m.id, fetchFn, '/archive');
      if (!raw) continue;
      const row = await parseRawOrderEmail(raw, m.id, { shared: true, envelopeTo: m.to });
      if (!row) continue;
      result.parsed++;
      if (row.egiftDelivery) deliveries.push(row);
    } catch {
      // a malformed or unreachable message is skipped
    }
  }
  result.deliveries = deliveries.length;
  if (deliveries.length) await ingest(deliveries);
  return result;
}

export const egiftBackfillLine = (r: EgiftBackfillResult) =>
  `[egift-backfill] ok=${r.ok} archived=${r.listed} parsed=${r.parsed} deliveries=${r.deliveries}`;
