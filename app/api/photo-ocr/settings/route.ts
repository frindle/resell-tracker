import { NextRequest } from 'next/server';
import { getSessionUserId } from '@/lib/auth';
import { getSetting, upsertSetting } from '@/lib/db';
import { photoOcrEnabled } from '@/lib/photoOcrRun';

export async function GET() {
  const uid = await getSessionUserId();
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });
  const auto = await getSetting(uid, 'photo_auto_assign');
  return Response.json({ ocrEnabled: photoOcrEnabled(), autoAssign: auto?.value === 'true' });
}

export async function PUT(req: NextRequest) {
  const uid = await getSessionUserId();
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({})) as { autoAssign?: boolean };
  if (typeof body.autoAssign !== 'boolean') return Response.json({ error: 'autoAssign must be true or false' }, { status: 400 });
  await upsertSetting(uid, 'photo_auto_assign', body.autoAssign ? 'true' : 'false');
  return Response.json({ autoAssign: body.autoAssign });
}
