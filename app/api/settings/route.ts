import { prisma, getSetting, upsertSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';

export async function GET() {
  try {
  const userId = await getSessionUserId();
  const uid = userId ?? null;
  const rows = await prisma.setting.findMany({ where: { userId: uid } });
  const settings: Record<string, string> = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  return Response.json(settings);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
  const userId = await getSessionUserId();
  const uid = userId ?? null;
  const body: Record<string, string> = await req.json();
  await Promise.all(
    Object.entries(body).map(([key, value]) => upsertSetting(uid, key, value))
  );
  return new Response(null, { status: 204 });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

// Keep getSetting exported for other routes that need it
export { getSetting };
