// POST /api/extension/commands "is this already queued?" rule, pulled out
// of app/api/extension/commands/route.ts so it is testable without Prisma.
//
// Dedupe used to match only status 'pending'. The sidecar marks a command
// 'running' within ~1s of it being queued (the POST kicks /poll-now), so a
// second Sync click during a scrape always created a second row that re-ran
// the whole list scrape afterwards. A payload-less command (the full syncs)
// is identical to the running one, so reuse it. A command with a payload
// (SYNC_AMAZON_ORDER's orderNumbers) may target different orders than the
// one already running, so it keeps the old pending-only match.
//
// Nothing reaps a 'running' row orphaned by a sidecar restart mid-scrape, so
// a running row only counts while it was touched within RUNNING_DEDUPE_MAX_AGE_MS
// -- otherwise one crash would swallow every later Sync click forever.

export const RUNNING_DEDUPE_MAX_AGE_MS = 15 * 60 * 1000;

export type ExtensionCommandDedupeWhere = {
  type: string;
  targetBrowser: string | null;
  OR: ({ status: 'pending' } | { status: 'running'; updatedAt: { gte: Date } })[];
};

export function extensionCommandDedupeWhere(
  type: string,
  targetBrowser: string | null,
  payload: unknown,
  now: Date = new Date(),
): ExtensionCommandDedupeWhere {
  const hasPayload = payload !== undefined && payload !== null;
  return {
    type,
    targetBrowser,
    OR: [
      { status: 'pending' },
      ...(hasPayload ? [] : [{ status: 'running' as const, updatedAt: { gte: new Date(now.getTime() - RUNNING_DEDUPE_MAX_AGE_MS) } }]),
    ],
  };
}

// Sync Status "Retry on sidecar" re-queues one failed row, payload and all
// (stored as the JSON string). A pending row of the same type for a different
// order (SYNC_AMAZON_ORDER / SYNC_COSTCO_ORDER / TRACK_AMAZON) is other work,
// so reusing it would drop the retried order. Only an equal payload counts.
export function retryDedupeWhere(
  type: string,
  targetBrowser: string | null,
  payload: string | null,
  now: Date = new Date(),
): ExtensionCommandDedupeWhere & { payload?: string } {
  const where = extensionCommandDedupeWhere(type, targetBrowser, payload, now);
  return payload === null ? where : { ...where, payload };
}
