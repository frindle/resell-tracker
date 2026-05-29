import { prisma } from '@/lib/db';
import { NextRequest } from 'next/server';

export async function GET() {
  const rows = await prisma.setting.findMany();
  const settings: Record<string, string> = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  return Response.json(settings);
}

export async function POST(req: NextRequest) {
  const body: Record<string, string> = await req.json();
  await Promise.all(
    Object.entries(body).map(([key, value]) =>
      prisma.setting.upsert({
        where: { key },
        update: { value },
        create: { key, value },
      })
    )
  );
  return new Response(null, { status: 204 });
}
