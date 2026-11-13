import { getSessionUserId } from '@/lib/auth';
import { runBackfillGuarded } from '@/lib/cardcenterImagesBackfill';

export const dynamic = 'force-dynamic';

// GET: dry-run counts (no CardCenter calls, no writes).
export async function GET() {
  try {
    const userId = await getSessionUserId();
    return Response.json(await runBackfillGuarded(userId, { dryRun: true }));
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

// POST: run now (links past photos, then sends up to the per-run reservation cap).
export async function POST() {
  try {
    const userId = await getSessionUserId();
    return Response.json(await runBackfillGuarded(userId, {}));
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
