import { prisma, getSetting } from '@/lib/db';
import { AMAZON_EXTENSION_TARGET } from '@/lib/amazonSync';
import { sendPushover } from '@/lib/pushover';
import {
  TRACK_AMAZON, RUNNING_STALE_MS, trackingUserId, parseTrackPayload, ordersToQueue, mergeTrackPayload, trackFailedText,
  type TrackPayload,
} from '@/lib/amazonTracking';

// Database side of lib/amazonTracking.ts: queue TRACK_AMAZON commands and
// tell the user when the Brave extension could not finish one.

/** Pending, or running and recently touched, TRACK_AMAZON commands. */
async function inFlightCommands(now: Date) {
  return prisma.extensionCommand.findMany({
    where: {
      type: TRACK_AMAZON,
      OR: [{ status: 'pending' }, { status: 'running', updatedAt: { gte: new Date(now.getTime() - RUNNING_STALE_MS) } }],
    },
    orderBy: { id: 'asc' },
  });
}

/**
 * Queues a tracking lookup for these Amazon orders (full numbers, e.g.
 * "111-2223334-4445556"). Returns null when this user's Amazon account isn't
 * the one the extension is signed in to, so the caller nudges instead.
 */
export async function queueAmazonTracking(userId: number, orderNumbers: readonly string[], now = new Date()): Promise<{ queued: string[]; target: string } | null> {
  if (userId !== trackingUserId()) return null;
  const target = AMAZON_EXTENSION_TARGET;
  const inFlight = await inFlightCommands(now);
  const queued = ordersToQueue(orderNumbers, inFlight.map(c => parseTrackPayload(c.payload)));
  if (!queued.length) return { queued, target };

  const add: TrackPayload = { orderNumbers: queued, userId };
  const pending = inFlight.find(c => c.status === 'pending' && c.targetBrowser === target);
  if (pending) {
    const merged = mergeTrackPayload(parseTrackPayload(pending.payload), add);
    await prisma.extensionCommand.update({ where: { id: pending.id }, data: { payload: JSON.stringify(merged) } });
  } else {
    await prisma.extensionCommand.create({ data: { type: TRACK_AMAZON, payload: JSON.stringify(add), targetBrowser: target } });
  }
  console.log(`[amazon-tracking] queued ${queued.length} order(s) for ${target} user=${userId}`);
  return { queued, target };
}

export async function notifyUser(userId: number, message: string, title = 'Amazon tracking'): Promise<void> {
  const [key, token] = await Promise.all([getSetting(userId, 'pushover_user_key'), getSetting(userId, 'pushover_app_token')]);
  if (!key?.value || !token?.value) return;
  await sendPushover(key.value, token.value, message, title).catch(e => console.error('[amazon-tracking] pushover failed:', String(e).slice(0, 160)));
}

/** Called by PATCH /api/extension/commands/[id]: a browser extension gave up on a TRACK_AMAZON. */
export async function reportTrackFailure(payloadJson: string | null, result: unknown): Promise<void> {
  const payload = parseTrackPayload(payloadJson);
  const userId = payload?.userId || trackingUserId();
  const r = (result && typeof result === 'object' ? result : null) as { error?: string; blocked?: boolean } | null;
  console.log(`[amazon-tracking] extension could not finish ${payload?.orderNumbers.length ?? 0} order(s) user=${userId} blocked=${!!r?.blocked}`);
  await notifyUser(userId, trackFailedText(payload, r));
}
