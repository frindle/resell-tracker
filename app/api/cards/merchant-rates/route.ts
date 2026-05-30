import { prisma } from '@/lib/db';
import { NextRequest } from 'next/server';

export async function POST(req: NextRequest) {
  const body = await req.json();
  const rate = await prisma.cardMerchantRate.create({
    data: {
      cardId: parseInt(body.cardId),
      merchant: body.merchant.trim(),
      pointsPerDollar: parseFloat(body.pointsPerDollar),
    },
  });
  return Response.json(rate, { status: 201 });
}
