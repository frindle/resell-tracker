import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';

export async function GET() {
  try {
  await getSessionUserId();
  const rows = await prisma.bgResolvedOrder.findMany({ select: { orderId: true } });
  return Response.json(rows.map(r => r.orderId));
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
  await getSessionUserId();
  const { orderId } = await req.json() as { orderId: string };
  if (!orderId) return Response.json({ error: 'orderId required' }, { status: 400 });
  await prisma.bgResolvedOrder.upsert({
    where: { orderId },
    update: {},
    create: { orderId },
  });
  return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
  await getSessionUserId();
  const { orderId } = await req.json() as { orderId: string };
  if (!orderId) return Response.json({ error: 'orderId required' }, { status: 400 });
  await prisma.bgResolvedOrder.deleteMany({ where: { orderId } });
  return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
