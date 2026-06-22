import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
  const userId = await getSessionUserId();
  const { id } = await params;
  const body = await req.json();
  const rate = body.rewardsRate !== '' && body.rewardsRate != null ? parseFloat(body.rewardsRate) : null;
  const base = body.basePointsPerDollar !== '' && body.basePointsPerDollar != null ? parseFloat(body.basePointsPerDollar) : null;
  const card = await prisma.creditCard.update({
    where: { id: parseInt(id), userId: userId ?? null },
    data: {
      name: body.name,
      last4: typeof body.last4 === 'string' && /^\d{4}$/.test(body.last4) ? body.last4 : null,
      milesProgram: body.milesProgram || null,
      rewardsRate: rate,
      basePointsPerDollar: base,
      spendYearType: body.spendYearType || 'calendar',
      spendYearResetMMDD: body.spendYearType === 'cardmember' ? (body.spendYearResetMMDD || null) : null,
    },
    include: { merchantRates: { orderBy: { merchant: 'asc' } } },
  });
  return Response.json(card);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
  const userId = await getSessionUserId();
  const { id } = await params;
  await prisma.creditCard.delete({ where: { id: parseInt(id), userId: userId ?? null } });
  return new Response(null, { status: 204 });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
