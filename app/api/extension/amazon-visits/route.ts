import { NextRequest } from 'next/server';
import { getSessionUserId } from '@/lib/auth';
import { resolveExtensionUserId } from '@/lib/extensionAuth';
import { pickClickVisits } from '@/lib/amazonVisitQueue';

export const dynamic = 'force-dynamic';

// A person clicked Sync Amazon: the orders the tracker already knows need a
// page visit (a small random subset, each stage once, recent visits skipped),
// and whether order-list page 1 is due (once a day, the safety net). This also
// lets email-triggered automatic visits run again after a block.
export async function POST(req: NextRequest) {
  try {
    const userId = resolveExtensionUserId(req, await getSessionUserId());
    if (userId == null) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const { visits, listDue } = await pickClickVisits(userId);
    return Response.json({ ok: true, visits, listDue });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
