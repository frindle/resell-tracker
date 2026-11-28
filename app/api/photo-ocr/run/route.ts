import { NextRequest } from 'next/server';
import { getSessionUserId } from '@/lib/auth';
import { enqueuePendingPhotos, enqueuePhotosByIds, photoOcrEnabled, stopPhotoOcr } from '@/lib/photoOcrRun';
import { parsePhotoIds } from '@/lib/photoOcrIds';

// Queues OCR + order matching for the user's unassigned photos: the ones
// never scanned or left pending/errored, or every one with {"rescan": true}.
// {"unmatched": true} also re-reads photos that matched nothing (after a new order).
// {"ids": [1, 2]} re-reads just those photos (1 to 50 of the user's own images).
export async function POST(req: NextRequest) {
  const uid = await getSessionUserId();
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });
  if (!photoOcrEnabled()) return Response.json({ error: 'Photo reading is off (GIFTCARD_OCR_ENABLED=false)' }, { status: 409 });
  const body = await req.json().catch(() => ({})) as { rescan?: boolean; unmatched?: boolean; ids?: unknown } | null;
  // {"ids": [...]} re-reads just those photos.
  if (body && body.ids !== undefined) {
    const parsed = parsePhotoIds(body.ids);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
    return Response.json({ queued: await enqueuePhotosByIds(uid, parsed.ids) });
  }
  const queued = await enqueuePendingPhotos(uid, body?.rescan === true, body?.unmatched === true);
  return Response.json({ queued });
}

// Stop reading: takes the user's waiting photos off the queue (the current one finishes).
export async function DELETE() {
  const uid = await getSessionUserId();
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });
  return Response.json({ stopped: await stopPhotoOcr(uid) });
}
