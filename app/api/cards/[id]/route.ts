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
  
  // Update the card
  const updatedCard = await prisma.creditCard.update({
    where: { id: parseInt(id), userId: userId ?? null },
    data: {
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
  
  // Handle additional last-4s if provided
  if (Array.isArray(body.additionalLastFours)) {
    const validLastFours = body.additionalLastFours.filter((last4: string) => typeof last4 === 'string' && /^\d{4}$/.test(last4));
    
    // Get existing last fours for this card to determine what needs to be deleted/added
    const existingLastFours = await prisma.creditCardLastFour.findMany({
      where: { cardId: parseInt(id) },
      select: { id: true, last4: true }
    });
    
    // Convert existing last-4s to a set for easy comparison
    const existingLastFoursSet = new Set(existingLastFours.map((lf: { last4: string }) => lf.last4));
    
    // Find which ones need to be deleted (exist in DB but not in new list)
    const toDelete = existingLastFours.filter((lf: { last4: string }) => !validLastFours.includes(lf.last4));
    
    // Find which ones need to be added (in new list but don't exist in DB)
    const toAdd = validLastFours.filter((last4: string) => !existingLastFoursSet.has(last4));
    
    // Delete the old ones
    if (toDelete.length > 0) {
      await prisma.creditCardLastFour.deleteMany({
        where: {
          cardId: parseInt(id),
          last4: { in: toDelete.map((lf: { last4: string }) => lf.last4) }
        }
      });
    }
    
    // Add the new ones
    if (toAdd.length > 0) {
      await prisma.creditCardLastFour.createMany({
        data: toAdd.map((last4: string) => ({
          cardId: parseInt(id),
          last4
        }))
      });
    }
  }

  // Re-fetch with all relations for response
  const fullCard = await prisma.creditCard.findUnique({
    where: { id: parseInt(id) },
    include: { 
      merchantRates: { orderBy: { merchant: 'asc' } },
      lastFours: true
    },
  });
  
  return Response.json(fullCard);
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
