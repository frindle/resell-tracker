import { getSessionUserId } from '@/lib/auth';
import { crossGroupFor } from '@/lib/crossGroupIndex';

export const dynamic = 'force-dynamic';

// Flags for deals that another group pays more for. Never an error: a group
// that is down is listed under `skipped`.
export async function GET() {
  const uid = await getSessionUserId();
  try {
    return Response.json(await crossGroupFor(uid ?? null));
  } catch (e) {
    return Response.json({ flags: {}, skipped: [], threshold: 1, asOf: Date.now(), error: String(e) });
  }
}
