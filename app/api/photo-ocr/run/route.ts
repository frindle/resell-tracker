import { NextRequest } from 'next/server';
import { getSessionUserId } from '@/lib/auth';
import { enqueuePendingPhotos, photoOcrEnabled } from '@/lib/photoOcrRun';

// Queues OCR + order matching for the user's unassigned photos: the ones
// never scanned or left pending/errored, or every one with {"rescan": true}.
export async function POST(req: NextRequest) {
  const uid = await getSessionUserId();
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });
  if (!photoOcrEnabled()) return Response.json({ error: 'Photo reading is off (GIFTCARD_OCR_ENABLED is not true)' }, { status: 409 });
  const body = await req.json().catch(() => ({})) as { rescan?: boolean };
  const queued = await enqueuePendingPhotos(uid, body.rescan === true);
  return Response.json({ queued });
}
