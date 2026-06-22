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
    include: { merchantRates: { orderBy: { merchant: 'asc' } } },
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
  const card = await prisma.creditCard.create({
    data: {
      userId: userId ?? null,
      name: body.name,
      last4: typeof body.last4 === 'string' && /^\d{4}$/.test(body.last4) ? body.last4 : null,
      milesProgram: body.milesProgram || null,
      rewardsRate: rate,
      basePointsPerDollar: base,
      spendYearType: body.spendYearType || 'calendar',
      spendYearResetMMDD: body.spendYearType === 'cardmember' ? (body.spendYearResetMMDD || null) : null,
    },
    include: { merchantRates: true },
  });
  return Response.json(card, { status: 201 });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
