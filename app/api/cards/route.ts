import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';

export async function GET() {
  const userId = await getSessionUserId();
  const cards = await prisma.creditCard.findMany({
    where: userId ? { userId } : { userId: null },
    orderBy: { name: 'asc' },
    include: { merchantRates: { orderBy: { merchant: 'asc' } } },
  });
  return Response.json(cards);
}

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  const body = await req.json();
  const rate = body.rewardsRate !== '' && body.rewardsRate != null ? parseFloat(body.rewardsRate) : null;
  const base = body.basePointsPerDollar !== '' && body.basePointsPerDollar != null ? parseFloat(body.basePointsPerDollar) : null;
  const card = await prisma.creditCard.create({
    data: { userId: userId ?? null, name: body.name, rewardsRate: rate, basePointsPerDollar: base },
    include: { merchantRates: true },
  });
  return Response.json(card, { status: 201 });
}
