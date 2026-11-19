import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';
import { ORIGINAL_FROM } from '@/lib/cardRates';
import { syncCardRates } from '@/lib/cardRateStore';

// Effective-dated rates for one card. POST adds (or replaces) the rate that
// starts on a day; DELETE removes a later entry (the original one stays).

async function ownedCard(id: string) {
  const userId = await getSessionUserId();
  return prisma.creditCard.findFirst({ where: { id: parseInt(id), userId: userId ?? null }, select: { id: true } });
}

const num = (v: unknown) => (v === '' || v == null ? null : Number.isFinite(Number(v)) ? Number(v) : NaN);

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!(await ownedCard(id))) return Response.json({ error: 'Not found' }, { status: 404 });
    return Response.json(await prisma.cardRateHistory.findMany({ where: { cardId: parseInt(id) }, orderBy: { effectiveFrom: 'desc' } }));
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!(await ownedCard(id))) return Response.json({ error: 'Not found' }, { status: 404 });
    const body = await req.json();
    const effectiveFrom = String(body.effectiveFrom ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom) || isNaN(Date.parse(effectiveFrom))) {
      return Response.json({ error: 'effectiveFrom must be a YYYY-MM-DD date' }, { status: 400 });
    }
    if (effectiveFrom <= ORIGINAL_FROM) return Response.json({ error: 'Pick a real start date' }, { status: 400 });
    const rewardsRate = num(body.rewardsRate);
    const basePointsPerDollar = num(body.basePointsPerDollar);
    if (Number.isNaN(rewardsRate) || Number.isNaN(basePointsPerDollar)) return Response.json({ error: 'Rate must be a number' }, { status: 400 });
    if (rewardsRate == null && basePointsPerDollar == null) return Response.json({ error: 'Enter a rate' }, { status: 400 });
    const cardId = parseInt(id);
    await prisma.cardRateHistory.upsert({
      where: { cardId_effectiveFrom: { cardId, effectiveFrom } },
      create: { cardId, effectiveFrom, rewardsRate, basePointsPerDollar },
      update: { rewardsRate, basePointsPerDollar },
    });
    await syncCardRates(cardId);
    return Response.json(await prisma.cardRateHistory.findMany({ where: { cardId }, orderBy: { effectiveFrom: 'desc' } }), { status: 201 });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!(await ownedCard(id))) return Response.json({ error: 'Not found' }, { status: 404 });
    const entryId = parseInt(req.nextUrl.searchParams.get('entryId') ?? '');
    const cardId = parseInt(id);
    const entry = await prisma.cardRateHistory.findFirst({ where: { id: entryId, cardId } });
    if (!entry) return Response.json({ error: 'Not found' }, { status: 404 });
    if (entry.effectiveFrom === ORIGINAL_FROM) return Response.json({ error: 'The original rate cannot be removed' }, { status: 400 });
    await prisma.cardRateHistory.delete({ where: { id: entryId } });
    await syncCardRates(cardId);
    return Response.json(await prisma.cardRateHistory.findMany({ where: { cardId }, orderBy: { effectiveFrom: 'desc' } }));
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
