import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';

export async function GET() {
  const userId = await getSessionUserId();
  const cards = await prisma.creditCard.findMany({
    where: userId ? { userId } : { userId: null },
    orderBy: { name: 'asc' },
  });
  return Response.json(cards);
}

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  const body = await req.json();
  const card = await prisma.creditCard.create({
    data: { userId: userId ?? null, name: body.name, rewardsRate: parseFloat(body.rewardsRate) || 0 },
  });
  return Response.json(card, { status: 201 });
}
