import { prisma } from '@/lib/db';
import { NextRequest } from 'next/server';

export async function GET() {
  const cards = await prisma.creditCard.findMany({ orderBy: { name: 'asc' } });
  return Response.json(cards);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const card = await prisma.creditCard.create({
    data: { name: body.name, rewardsRate: parseFloat(body.rewardsRate) || 0 },
  });
  return Response.json(card, { status: 201 });
}
