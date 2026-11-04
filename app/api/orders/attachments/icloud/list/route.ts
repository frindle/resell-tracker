import { NextRequest } from 'next/server';
import { getSessionUserId } from '@/lib/auth';
import { listIcloudLink } from '@/lib/icloudLink';

// Step 1 of an iCloud link import: list the photos behind a shared link
// (iCloud Link or Shared Album) with a short-lived download address each.
// The page then calls ../fetch once per photo.
export async function POST(req: NextRequest) {
  const uid = await getSessionUserId();
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({})) as { link?: string };
  try {
    const items = await listIcloudLink((body.link ?? '').trim());
    return Response.json({ items });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
