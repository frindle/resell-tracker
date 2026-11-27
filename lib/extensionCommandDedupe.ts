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
  payload?: string | { in: string[] };
  OR: ({ status: 'pending' } | { status: 'running'; updatedAt: { gte: Date } })[];
};

// SCRAPE_EGIFT carries one order id. Two clicks on the same order are one job,
// but a second order is other work, so its payload takes part in the match.
const SCRAPE_EGIFT = 'SCRAPE_EGIFT';

// Fixed key order so the stored JSON string compares equal for the same order.
// `runner: 'plan'` and `dryRun: true` (only together with plan) survive; anything else is dropped.
export function canonicalCommandPayload(type: string, payload: unknown): unknown {
  if (type !== SCRAPE_EGIFT || !payload || typeof payload !== 'object') return payload;
  const p = payload as { orderId?: unknown; runner?: unknown; dryRun?: unknown };
  const orderId = p.orderId;
  if (typeof orderId !== 'number' || !Number.isInteger(orderId)) return payload;
  const plan = p.runner === 'plan';
  return { orderId, ...(plan ? { runner: 'plan' } : {}), ...(plan && p.dryRun === true ? { dryRun: true } : {}) };
}

/** The stored payload strings of the REAL (saving) scrape for one order: the built-in and the plan form. */
export function egiftRealPayloadForms(orderId: number): string[] {
  return [JSON.stringify({ orderId }), JSON.stringify({ orderId, runner: 'plan' })];
}

/**
 * Payload match for SCRAPE_EGIFT. A real scrape matches either form (built-in or plan) so switching the
 * runner never re-scrapes a done order; a dry run matches only its own exact payload, and a real
 * match never hits a dry-run row because dry-run payloads are not among the real forms.
 */
export function egiftPayloadMatch(payload: unknown): string | { in: string[] } {
  const c = canonicalCommandPayload(SCRAPE_EGIFT, payload) as { orderId?: unknown; dryRun?: unknown } | null;
  if (c && typeof c === 'object' && c.dryRun === true) return JSON.stringify(c);
  if (c && typeof c === 'object' && typeof c.orderId === 'number' && Number.isInteger(c.orderId)) return { in: egiftRealPayloadForms(c.orderId) };
  return JSON.stringify(c);
}

export function extensionCommandDedupeWhere(
  type: string,
  targetBrowser: string | null,
  payload: unknown,
  now: Date = new Date(),
): ExtensionCommandDedupeWhere {
  const hasPayload = payload !== undefined && payload !== null;
  const where: ExtensionCommandDedupeWhere = {
    type,
    targetBrowser,
    OR: [
      { status: 'pending' },
      ...(hasPayload ? [] : [{ status: 'running' as const, updatedAt: { gte: new Date(now.getTime() - RUNNING_DEDUPE_MAX_AGE_MS) } }]),
    ],
  };
  if (type === SCRAPE_EGIFT && hasPayload) where.payload = egiftPayloadMatch(payload);
  return where;
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
): ExtensionCommandDedupeWhere {
  if (type === SCRAPE_EGIFT && payload !== null) {
    let parsed: unknown;
    try { parsed = JSON.parse(payload); } catch { parsed = undefined; }
    if (parsed && typeof parsed === 'object') return extensionCommandDedupeWhere(type, targetBrowser, parsed, now);
  }
  const where = extensionCommandDedupeWhere(type, targetBrowser, payload, now);
  return payload === null ? where : { ...where, payload };
}
