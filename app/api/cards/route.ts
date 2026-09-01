import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';

function spendPeriodStart(card: { spendYearType: string; spendYearResetMMDD: string | null }): Date {
  const now = new Date();
  if (card.spendYearType === 'cardmember' && card.spendYearResetMMDD) {
    const [mm, dd] = card.spendYearResetMMDD.split('/').map(Number);
    if (mm && dd) {
      let reset = new Date(now.getFullYear(), mm - 1, dd);
      if (reset > now) reset = new Date(now.getFullYear() - 1, mm - 1, dd);
      return reset;
    }
  }
  return new Date(now.getFullYear(), 0, 1);
}

export async function GET() {
  try {
  const userId = await getSessionUserId();
  const cards = await prisma.creditCard.findMany({
    where: userId ? { userId } : { userId: null },
    orderBy: { name: 'asc' },
    include: { 
      merchantRates: { orderBy: { merchant: 'asc' } },
      lastFours: true // Include additional last-4s
    },
  });

  const spends = await Promise.all(cards.map(async (card) => {
    const periodStart = spendPeriodStart(card);
    const orders = await prisma.order.aggregate({
      where: { cardId: card.id, orderDate: { gte: periodStart }, lost: false },
      _sum: { cost: true, shippingCost: true, insuranceCost: true },
    });
    const spend = (orders._sum.cost ?? 0) + (orders._sum.shippingCost ?? 0) + (orders._sum.insuranceCost ?? 0);
    return { cardId: card.id, spend };
  }));

  const spendMap = Object.fromEntries(spends.map(s => [s.cardId, s.spend]));
  const result = cards.map(c => ({ ...c, currentSpend: spendMap[c.id] ?? 0 }));
  return Response.json(result);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
  const userId = await getSessionUserId();
  const body = await req.json();
  const rate = body.rewardsRate !== '' && body.rewardsRate != null ? parseFloat(body.rewardsRate) : null;
  const base = body.basePointsPerDollar !== '' && body.basePointsPerDollar != null ? parseFloat(body.basePointsPerDollar) : null;
  
  // Create the card first
  const card = await prisma.creditCard.create({
    data: {
      userId: userId ?? null,
      name: body.name,
      last4: typeof body.last4 === 'string' && /^\d{4}$/.test(body.last4) ? body.last4 : null,
      milesProgram: body.milesProgram || null,
      rewardsRate: rate,
      excludeShippingFromCashback: !!body.excludeShippingFromCashback,
      basePointsPerDollar: base,
      spendYearType: body.spendYearType || 'calendar',
      spendYearResetMMDD: body.spendYearType === 'cardmember' ? (body.spendYearResetMMDD || null) : null,
    },
  });
  
  // If additional last-4s are provided, create them
  if (Array.isArray(body.additionalLastFours)) {
    const validLastFours = body.additionalLastFours.filter((last4: string) => typeof last4 === 'string' && /^\d{4}$/.test(last4));
    if (validLastFours.length > 0) {
      await prisma.creditCardLastFour.createMany({
        data: validLastFours.map((last4: string) => ({
          cardId: card.id,
          last4
        }))
      });
    }
  }

  // Re-fetch the card with all relations for response
  const fullCard = await prisma.creditCard.findUnique({
    where: { id: card.id },
    include: { 
      merchantRates: { orderBy: { merchant: 'asc' } },
      lastFours: true
    },
  });
  
  return Response.json(fullCard, { status: 201 });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
