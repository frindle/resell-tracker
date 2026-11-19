// Database side of lib/cardRates.ts: keeps a card's rate columns equal to the
// history entry in effect today.
import { prisma } from '@/lib/db';
import { rateEntryOn, todayKey, currentRateTarget } from '@/lib/cardRates';

const today = todayKey;

/** Copy the entry in effect today onto the card's own rate columns. */
export async function syncCardRates(cardId: number): Promise<void> {
  const history = await prisma.cardRateHistory.findMany({ where: { cardId } });
  const e = rateEntryOn(history, today());
  if (!e) return;
  await prisma.creditCard.update({ where: { id: cardId }, data: { rewardsRate: e.rewardsRate, basePointsPerDollar: e.basePointsPerDollar } });
}

/**
 * A card edit that sets the rate changes the rate from today on: it adds (or
 * replaces) today's entry and leaves older entries alone, so past orders keep
 * the rate they earned at. A card with no history gets its original entry.
 */
export async function setCurrentRate(cardId: number, rewardsRate: number | null, basePointsPerDollar: number | null): Promise<void> {
  const history = await prisma.cardRateHistory.findMany({ where: { cardId } });
  const effectiveFrom = currentRateTarget(history, rewardsRate, basePointsPerDollar, today());
  if (effectiveFrom == null) return;
  await prisma.cardRateHistory.upsert({
    where: { cardId_effectiveFrom: { cardId, effectiveFrom } },
    create: { cardId, effectiveFrom, rewardsRate, basePointsPerDollar },
    update: { rewardsRate, basePointsPerDollar },
  });
}
