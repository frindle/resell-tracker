import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { isReviewCard } from '@/lib/giftCardReview';
import { currentRates, loopbackPost } from '@/lib/waitlistRunner';
import { aggregateBatch, planBatch, type BatchCard, type GroupOutcome } from '@/lib/ccBatch';
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

// Card ids with a batch in flight in this process: a double click or a second
// tab must not send the same card twice while the first run is still going.
const inFlight = new Set<number>();

async function loadCards(userId: number | null, ids: number[]): Promise<BatchCard[]> {
  const rows = await prisma.giftCard.findMany({
    where: { id: { in: ids }, order: { userId } },
    select: { id: true, orderId: true, merchant: true, value: true, ccSubmittedAt: true, codeSource: true },
  });
  return rows.map(r => ({
    id: r.id, orderId: r.orderId, merchant: r.merchant, value: r.value,
    ccSubmittedAt: r.ccSubmittedAt, needsReview: isReviewCard(r),
  }));
}

/**
 * POST { cardIds: number[], dryRun?: boolean }
 *
 * Groups the cards by buy order (best live rate for brand and value) and the
 * tracker order they belong to, then sells each group through the existing
 * /api/cardcenter/reserve flow (reserve, then submit, then record). A
 * no-reservation path is not wired in: see lib/ccNoReservation.ts.
 * dryRun returns the plan (count, brands, face, payout) and sends nothing.
 */
export async function POST(req: NextRequest) {
  try {
    const userId = await getSessionUserId();
    const body = await req.json() as { cardIds?: unknown[]; dryRun?: boolean };
    const ids = [...new Set((body.cardIds ?? []).filter((n): n is number => Number.isInteger(n)))];
    if (ids.length === 0) return Response.json({ error: 'cardIds required' }, { status: 400 });
    if (ids.length > 200) return Response.json({ error: 'At most 200 cards at once' }, { status: 400 });

    const rates = await currentRates(userId);
    const plan = planBatch(ids, await loadCards(userId, ids), rates);
    if (body.dryRun === true) return Response.json({ dryRun: true, plan });

    const locked = ids.filter(id => inFlight.has(id));
    if (locked.length) {
      return Response.json({ error: 'A batch including some of these cards is already running' }, { status: 409 });
    }
    const mine = plan.groups.flatMap(g => g.cardIds);
    mine.forEach(id => inFlight.add(id));
    const outcomes: GroupOutcome[] = [];
    try {
      for (const group of plan.groups) {
        let error: string | undefined;
        try {
          // Re-check right before sending: a card that sold since the plan was made is never sent again.
          const fresh = await prisma.giftCard.findMany({
            where: { id: { in: group.cardIds }, ccSubmittedAt: null, order: { userId } },
            select: { id: true },
          });
          const cardIds = fresh.map(c => c.id);
          if (cardIds.length === 0) { outcomes.push({ group, submittedIds: group.cardIds }); continue; }
          const res = await loopbackPost('/api/cardcenter/reserve', userId, {
            buyOrderId: group.buyOrderId, quantity: cardIds.length, cardIds,
          }) as { submitError?: string; error?: string };
          if (res.submitError || res.error) error = res.submitError ?? res.error;
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
        // The database is the truth: a card counts as submitted only if it was recorded.
        const done = await prisma.giftCard.findMany({
          where: { id: { in: group.cardIds }, ccSubmittedAt: { not: null } },
          select: { id: true },
        });
        const submittedIds = done.map(c => c.id);
        if (submittedIds.length) {
          await prisma.giftCard.updateMany({
            where: { id: { in: submittedIds }, waitlistStatus: { not: null } },
            data: { waitlistStatus: 'SUBMITTED', waitlistUpdatedAt: new Date() },
          });
        }
        outcomes.push({ group, submittedIds, error });
      }
    } finally {
      mine.forEach(id => inFlight.delete(id));
    }

    return Response.json({ plan, ...aggregateBatch(plan, outcomes) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
