import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';

export async function GET() {
  const userId = await getSessionUserId();
  const rows = await prisma.setting.findMany({ where: { userId: userId ?? null } });
  const settings: Record<string, string> = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  return Response.json(settings);
}

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  const body: Record<string, string> = await req.json();
  await Promise.all(
    Object.entries(body).map(([key, value]) =>
      prisma.setting.upsert({
        where: { userId_key: { userId: userId ?? null, key } },
        update: { value },
        create: { userId: userId ?? null, key, value },
      })
    )
  );
  return new Response(null, { status: 204 });
}
