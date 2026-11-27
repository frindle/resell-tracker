import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { verifyExtensionSecret, resolveExtensionUserId } from '@/lib/extensionAuth';
import { getSessionUserId } from '@/lib/auth';
import { costcoAutoSyncStatus } from '@/lib/costcoAutoSyncQueue';
import { extensionCommandTargetFilter } from '@/lib/extensionCommandTargeting';
import { isExtensionCommandType } from '@/lib/extensionCommandTypes';
import { extensionCommandDedupeWhere, canonicalCommandPayload } from '@/lib/extensionCommandDedupe';
import { TRACK_AMAZON, parseTrackPayload, mergeTrackPayload, trackingUserId } from '@/lib/amazonTracking';
import { AMAZON_COMMAND_TYPES, AMAZON_EXTENSION_TARGET, COSTCO_COMMAND_TYPES } from '@/lib/amazonSync';
import { commandTarget, isCostcoCommand } from '@/lib/commandWorker';
import { materializeCostcoAutoSync } from '@/lib/costcoAutoSyncQueue';
import { materializeAutoVisits } from '@/lib/amazonVisitQueue';
import { TRACK_CARRIER, CARRIER_EXTENSION_TARGET } from '@/lib/carrierPlan';
import { materializeCarrierChecks } from '@/lib/carrierQueue';
import { kickSidecarPoll } from '@/lib/sidecarKick';
import { scrapeConfigVersion } from '@/lib/scrapeConfigLoaded';

// See app/api/settings/route.ts for why -- same class of bug, and this
// route filters by X-Extension-Browser per-request, so a cached response
// would serve the wrong browser's command queue.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
  if (req.nextUrl.searchParams.get('costcoAuto') === '1') {
    // The settings page's Costco auto-sync line: cookie-authenticated like
    // `all` below. Answers from the same settings and rows the poll's
    // planner uses, for the logged-in user.
    const uid = await getSessionUserId();
    if (uid == null) return Response.json({ error: 'unauthorized' }, { status: 401 });
    return Response.json(await costcoAutoSyncStatus(uid));
  }
  const all = req.nextUrl.searchParams.get('all') === '1';
  if (all) {
    // The settings page's "Recent commands" admin view -- an ordinary
    // cookie-authenticated request from the web UI (proxy.ts already
    // requires the session cookie for this route otherwise), never sends
    // X-Extension-Secret, so this branch deliberately does NOT gate on it.
    const commands = await prisma.extensionCommand.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return Response.json(commands);
  }
  // This is the poller-claim path a real browser extension could otherwise
  // reach: proxy.ts only classifies a request as "extension traffic" (and
  // gates it on EXTENSION_SHARED_SECRET) when it carries X-Extension-User-Id
  // or a chrome/moz-extension:// origin. An extension's content-script poll
  // runs same-origin-ish against amazon.com/walmart.com and may authenticate
  // purely via the ordinary resell_uid session cookie of a browser that's
  // also logged into the tracker web UI -- which sails past that heuristic
  // entirely and never hits proxy.ts's secret check. Enforce it here too, so
  // claiming actual pending commands requires the secret whenever one is
  // configured, regardless of which door the request came in.
  if (!verifyExtensionSecret(req)) {
    return Response.json({ error: 'extension secret missing or invalid' }, { status: 401 });
  }
  // Filter to commands either un-targeted OR targeting this caller's
  // browser. The extension sends 'firefox' or 'chrome' as
  // X-Extension-Browser on its poll request; commands with a
  // targetBrowser set get claimed only by the matching extension.
  // Older / untargeted commands are claimed by whoever polls first.
  const browser = req.headers.get('X-Extension-Browser')?.toLowerCase() || null;
  // Amazon is extension-only. Rows still waiting for the sidecar (queued
  // before it stopped doing Amazon) move to the extension as it polls.
  if (browser === AMAZON_EXTENSION_TARGET) {
    await prisma.extensionCommand.updateMany({
      where: { status: 'pending', targetBrowser: 'sidecar', type: { in: [...AMAZON_COMMAND_TYPES] } },
      data: { targetBrowser: AMAZON_EXTENSION_TARGET },
    });
    // An Amazon order email's random wait is over: hand the extension its visit.
    await materializeAutoVisits().catch(e => console.error('[amazon-visits] materialize failed:', String(e).slice(0, 160)));
    // Costco is the extension's too. Rows queued for the sidecar before the
    // switch move over, and the timed sync is queued here when it is due.
    await prisma.extensionCommand.updateMany({
      where: { status: 'pending', targetBrowser: 'sidecar', type: { in: [...COSTCO_COMMAND_TYPES] } },
      data: { targetBrowser: AMAZON_EXTENSION_TARGET },
    });
    // For the user the extension polls as: the same one whose Settings page holds the interval.
    const costcoUid = resolveExtensionUserId(req, await getSessionUserId()) ?? trackingUserId();
    await materializeCostcoAutoSync(costcoUid).catch(e => console.error('[costco-auto-sync] failed:', String(e).slice(0, 160)));
    // FedEx / UPS lookups for BG-bound shipments that are due.
    await materializeCarrierChecks().catch(e => console.error('[carrier-track] materialize failed:', String(e).slice(0, 160)));
  }
  const commands = await prisma.extensionCommand.findMany({
    where: {
      status: 'pending',
      ...extensionCommandTargetFilter(browser),
    },
    orderBy: { createdAt: 'asc' },
  });
  // The body stays a plain array; the scrape config version rides in a header so
  // the extension can fetch a newer config (/api/extension/scrape-config) at once.
  return Response.json(commands, scrapeConfigVersion != null ? { headers: { 'X-Scrape-Config-Version': String(scrapeConfigVersion) } } : undefined);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
  const { type, payload: rawPayload, targetBrowser } = await req.json() as { type: string; payload?: unknown; targetBrowser?: string };
  if (!type?.trim()) return new Response('type is required', { status: 400 });
  const payload = canonicalCommandPayload(type, rawPayload);

  if (!isExtensionCommandType(type)) return new Response(`unknown type: ${type}`, { status: 400 });

  let normalizedTarget = targetBrowser?.toLowerCase().trim() || null;
  // Amazon is read by the browser extension only: never leave one untargeted
  // or pointed at the sidecar.
  if ((AMAZON_COMMAND_TYPES as readonly string[]).includes(type) && (normalizedTarget === null || normalizedTarget === 'sidecar')) {
    normalizedTarget = AMAZON_EXTENSION_TARGET;
  }
  // Same for Costco; commandTarget (lib/commandWorker.ts) is the one place that says so.
  if (isCostcoCommand(type) && (normalizedTarget === null || normalizedTarget === 'sidecar')) {
    normalizedTarget = commandTarget(type);
  }
  // Carrier page reads are extension-only too.
  if (type === TRACK_CARRIER && (normalizedTarget === null || normalizedTarget === 'sidecar')) {
    normalizedTarget = CARRIER_EXTENSION_TARGET;
  }

  // Dedupe: if a pending (or, for payload-less syncs, running) command of
  // this type AND target already exists, return it -- see lib/extensionCommandDedupe.ts
  const existing = await prisma.extensionCommand.findFirst({
    where: extensionCommandDedupeWhere(type, normalizedTarget, payload),
  });
  // Kick the sidecar so it claims this command immediately instead of
  // waiting up to its POLL_INTERVAL_MS poll tick (see /poll-now in
  // sidecar/src/poll.js). Fire-and-forget, exactly like pushVncPasswordRefresh
  // in app/api/settings/route.ts: a slow/absent sidecar must not delay or
  // fail this response — the 60s poll remains the fallback. Idempotent:
  // pollOnce() only claims pending commands.
  if (existing) {
    // A second tracking hand-off adds its orders to the waiting one instead
    // of being dropped (lib/amazonTracking.ts).
    if (type === TRACK_AMAZON && existing.status === 'pending') {
      const add = parseTrackPayload(JSON.stringify(payload ?? null));
      if (add) {
        const merged = mergeTrackPayload(parseTrackPayload(existing.payload), add);
        const updated = await prisma.extensionCommand.update({ where: { id: existing.id }, data: { payload: JSON.stringify(merged) } });
        kickSidecarPoll();
        return Response.json(updated, { status: 200 });
      }
    }
    kickSidecarPoll();
    return Response.json(existing, { status: 200 });
  }

  const command = await prisma.extensionCommand.create({
    data: { type, payload: payload ? JSON.stringify(payload) : null, targetBrowser: normalizedTarget },
  });
  kickSidecarPoll();
  return Response.json(command, { status: 201 });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
