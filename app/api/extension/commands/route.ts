import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET(req: NextRequest) {
  try {
  const all = req.nextUrl.searchParams.get('all') === '1';
  if (all) {
    const commands = await prisma.extensionCommand.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return Response.json(commands);
  }
  const commands = await prisma.extensionCommand.findMany({
    where: { status: 'pending' },
    orderBy: { createdAt: 'asc' },
  });
  return Response.json(commands);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
  const { type, payload } = await req.json() as { type: string; payload?: unknown };
  if (!type?.trim()) return new Response('type is required', { status: 400 });

  const valid = ['SYNC_AMAZON', 'SYNC_WALMART', 'SYNC_COSTCO', 'SYNC_BIGSKY', 'SCRAPE_CBM', 'SYNC_AMAZON_ORDER'];
  if (!valid.includes(type)) return new Response(`unknown type: ${type}`, { status: 400 });

  // Dedupe: if a pending command of this type already exists, return it
  const existing = await prisma.extensionCommand.findFirst({
    where: { type, status: 'pending' },
  });
  if (existing) return Response.json(existing, { status: 200 });

  const command = await prisma.extensionCommand.create({
    data: { type, payload: payload ? JSON.stringify(payload) : null },
  });
  return Response.json(command, { status: 201 });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
