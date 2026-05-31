import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getSessionUserId();
  const { id } = await params;
  const body = await req.json();
  const rate = body.rewardsRate !== '' && body.rewardsRate != null ? parseFloat(body.rewardsRate) : null;
  const base = body.basePointsPerDollar !== '' && body.basePointsPerDollar != null ? parseFloat(body.basePointsPerDollar) : null;
  const card = await prisma.creditCard.update({
    where: { id: parseInt(id), userId: userId ?? null },
    data: { name: body.name, rewardsRate: rate, basePointsPerDollar: base },
    include: { merchantRates: { orderBy: { merchant: 'asc' } } },
  });
  return Response.json(card);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getSessionUserId();
  const { id } = await params;
  await prisma.creditCard.delete({ where: { id: parseInt(id), userId: userId ?? null } });
  return new Response(null, { status: 204 });
}
