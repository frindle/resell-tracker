import { prisma } from '@/lib/db';
import { NextRequest } from 'next/server';

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
  const { id } = await params;
  await prisma.shippingRule.delete({ where: { id: parseInt(id) } });
  return new Response(null, { status: 204 });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
  const { id } = await params;
  const { label, pattern, buyerId } = await req.json();
  const rule = await prisma.shippingRule.update({
    where: { id: parseInt(id) },
    data: {
      ...(label !== undefined && { label }),
      ...(pattern !== undefined && { pattern }),
      buyerId: buyerId !== undefined ? (buyerId ? parseInt(buyerId) : null) : undefined,
    },
    include: { buyer: { select: { id: true, name: true } } },
  });
  return Response.json(rule);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
