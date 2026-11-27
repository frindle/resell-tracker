import { getSessionUserId } from '@/lib/auth';
import { resolveExtensionUserId } from '@/lib/extensionAuth';
import { syncBfmrReservations } from '@/lib/bfmrReservationSync';

export const dynamic = 'force-dynamic';

// The work lives in lib/bfmrReservationSync.ts (the import runs it too).
export async function POST(req: Request) {
  const sessionUid = await getSessionUserId();
  // Same non-session caller support as the CC sync route — used by the
  // extension and the in-process auto-sync scheduler (loopback).
  const uid = resolveExtensionUserId(req, sessionUid);
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });
  return syncBfmrReservations(uid, req);
}
