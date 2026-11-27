import { getSessionUserId } from '@/lib/auth';
import { resolveExtensionUserId } from '@/lib/extensionAuth';
import { syncBgCommitments } from '@/lib/bgCommitmentSync';
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

// Sync the user's BuyingGroup commitments into our DB. Upserts by
// (userId, commitmentId). Called from the /buyinggroup/commitments page
// "Sync now" button AND auto-fired by the extension API Spy when it
// detects a successful edit_commitment on buyinggroup.com (#76).
// The work lives in lib/bgCommitmentSync.ts (the import runs it too).
export async function POST(req: NextRequest) {
  const sessionUid = await getSessionUserId();
  const uid = resolveExtensionUserId(req, sessionUid);
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });
  return syncBgCommitments(uid);
}
