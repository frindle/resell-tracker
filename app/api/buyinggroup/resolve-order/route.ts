import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';

export async function GET() {
  await getSessionUserId();
  const rows = await prisma.bgResolvedOrder.findMany({ select: { orderId: true } });
  return Response.json(rows.map(r => r.orderId));
}

export async function POST(req: NextRequest) {
  await getSessionUserId();
  const { orderId } = await req.json() as { orderId: string };
  if (!orderId) return Response.json({ error: 'orderId required' }, { status: 400 });
  await prisma.bgResolvedOrder.upsert({
    where: { orderId },
    update: {},
    create: { orderId },
  });
  return Response.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  await getSessionUserId();
  const { orderId } = await req.json() as { orderId: string };
  if (!orderId) return Response.json({ error: 'orderId required' }, { status: 400 });
  await prisma.bgResolvedOrder.deleteMany({ where: { orderId } });
  return Response.json({ ok: true });
}
