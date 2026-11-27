import { getSessionUserId } from '@/lib/auth';
import { resolveExtensionUserId } from '@/lib/extensionAuth';
import { syncBigSkyCommitments } from '@/lib/bigskyCommitmentSync';
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

// Read-only copy of the user's BigSky commitments (work in lib/bigskyCommitmentSync.ts).
export async function POST(req: NextRequest) {
  try {
    const uid = resolveExtensionUserId(req, await getSessionUserId());
    if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });
    return await syncBigSkyCommitments(uid);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
