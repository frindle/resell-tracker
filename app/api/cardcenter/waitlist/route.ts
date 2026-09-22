import { prisma, getSetting, upsertSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { resolveExtensionUserId } from '@/lib/extensionAuth';
import { planWaitlistRun, type BuyOrderRate } from '@/lib/ccWaitlist';
import {
  AUTO_SETTING_KEY,
  currentRates,
  runWaitlistForUser,
  todayStamp,
  unsoldCards,
  waitlistedCards,
} from '@/lib/waitlistRunner';
import { NextRequest } from 'next/server';

// Live per-user query plus a money path — never a build-time snapshot.
export const dynamic = 'force-dynamic';

/**
 * GET — every unsold card with its waitlist settings, the rate CardCenter is
 * paying for it right now, and what a run today would do about it. One response
 * backs the whole page, so the table can never disagree with the decision the
 * Run button is about to make.
 */
export async function GET() {
  try {
    const userId = await getSessionUserId();
    const cards = await unsoldCards(userId);

    let rates: BuyOrderRate[] = [];
    let ratesError: string | null = null;
    try {
      rates = await currentRates(userId);
    } catch (e) {
      // A rates outage must not blank the page: the cards and their settings
      // are still worth showing, just without a live decision.
      ratesError = e instanceof Error ? e.message : String(e);
    }

    const today = todayStamp();
    const planned = planWaitlistRun(waitlistedCards(cards), rates, today);
    const byId = new Map(planned.map(p => [Number(p.card.id), p]));

    return Response.json({
      today,
      autoEnabled: (await getSetting(userId, AUTO_SETTING_KEY))?.value === 'true',
      ratesError,
      cards: cards.map(c => {
        const p = byId.get(c.id);
        return {
          ...c,
          onWaitlist: c.waitlistTargetRate != null && c.waitlistMaxDate != null,
          currentRate: p?.rate?.rate ?? null,
          buyOrderId: p?.rate?.id ?? null,
          availableCap: p?.rate?.availableCap ?? null,
          decision: p?.decision ?? null,
        };
      }),
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

/**
 * PATCH — set or clear one card's waitlist, or flip the unattended runner on
 * and off. Sending null for either field takes the card off the waitlist; the
 * runner then ignores it entirely.
 */
export async function PATCH(req: NextRequest) {
  try {
    const userId = await getSessionUserId();
    const body = await req.json() as {
      cardId?: number;
      targetRate?: number | null;
      maxDate?: string | null;
      autoEnabled?: boolean;
    };

    if (typeof body.autoEnabled === 'boolean') {
      await upsertSetting(userId, AUTO_SETTING_KEY, body.autoEnabled ? 'true' : 'false');
      return Response.json({ autoEnabled: body.autoEnabled });
    }

    if (!Number.isInteger(body.cardId)) {
      return Response.json({ error: 'cardId required' }, { status: 400 });
    }
    // Ownership: GiftCard has no userId of its own, it inherits the order's.
    const card = await prisma.giftCard.findFirst({
      where: { id: body.cardId as number, order: { userId } },
      select: { id: true, ccSubmittedAt: true },
    });
    if (!card) return Response.json({ error: 'Not found' }, { status: 404 });
    if (card.ccSubmittedAt) {
      return Response.json({ error: 'Card is already submitted to CardCenter' }, { status: 409 });
    }

    const clearing = body.targetRate == null || body.maxDate == null;
    if (!clearing) {
      const rate = Number(body.targetRate);
      // The rate is a FRACTION of face value, the unit CardCenter's own API
      // uses (0.85 = 85%). A percent slipping in here would submit at the first
      // opportunity, so it is refused rather than coerced.
      if (!Number.isFinite(rate) || rate <= 0 || rate > 1) {
        return Response.json(
          { error: 'targetRate must be a fraction between 0 and 1 (0.85 = 85%)' },
          { status: 400 },
        );
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.maxDate))) {
        return Response.json({ error: 'maxDate must be YYYY-MM-DD' }, { status: 400 });
      }
    }

    const updated = await prisma.giftCard.update({
      where: { id: card.id },
      data: clearing
        ? {
            waitlistTargetRate: null,
            waitlistMaxDate: null,
            waitlistStatus: null,
            waitlistUpdatedAt: new Date(),
          }
        : {
            waitlistTargetRate: Number(body.targetRate),
            waitlistMaxDate: String(body.maxDate),
            waitlistStatus: 'WAITING',
            waitlistUpdatedAt: new Date(),
          },
      select: {
        id: true, waitlistTargetRate: true, waitlistMaxDate: true, waitlistStatus: true,
      },
    });
    return Response.json(updated);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

/**
 * POST — run the waitlist now. `{ dryRun: true }` returns the same plan without
 * submitting or writing anything, which is how the page previews a run.
 */
export async function POST(req: NextRequest) {
  try {
    const userId = resolveExtensionUserId(req, await getSessionUserId());
    const body = await req.json().catch(() => ({})) as { dryRun?: boolean };
    return Response.json(await runWaitlistForUser(userId, { dryRun: body.dryRun === true }));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
