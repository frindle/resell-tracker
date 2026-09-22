import { prisma, getSetting } from './db';
import { ccApiFetch, ccJson } from './cardcenter';
import {
  planWaitlistRun,
  type BuyOrderRate,
  type WaitlistCardWithBrand,
} from './ccWaitlist';

// CardCenter waitlist runner. The user parks an unsold gift card with a target
// sell rate and a deadline; this looks up what CardCenter is paying for that
// brand/denomination right now and submits, waits, or expires the card.
//
// The decision itself lives in lib/ccWaitlist.ts (pure, unit-tested). This file
// is only the I/O around it: read the cards, fetch live rates, and turn a
// decision into a reservation.

export const AUTO_SETTING_KEY = 'cc_waitlist_auto_enabled';

const RUN_MS = 60 * 60 * 1000; // hourly — CC rates move through the day
const BOOT_DELAY_MS = 15 * 60 * 1000; // stagger away from autoSync's boot run

export type UnsoldCard = {
  id: number;
  orderId: number;
  merchant: string;
  value: number;
  waitlistTargetRate: number | null;
  waitlistMaxDate: string | null;
  waitlistStatus: string | null;
};

export type WaitlistRunResult = {
  today: string;
  dryRun: boolean;
  submitted: number[];
  waiting: number[];
  expired: number[];
  errors: Array<{ id: number; message: string }>;
};

/** Today in the server's local zone as YYYY-MM-DD — deadlines compare as strings. */
export function todayStamp(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Every card that has not been sold to CardCenter yet. Unsold IS ccSubmittedAt null. */
export async function unsoldCards(userId: number | null): Promise<UnsoldCard[]> {
  return prisma.giftCard.findMany({
    where: { ccSubmittedAt: null, order: { userId } },
    select: {
      id: true, orderId: true, merchant: true, value: true,
      waitlistTargetRate: true, waitlistMaxDate: true, waitlistStatus: true,
    },
    orderBy: [{ merchant: 'asc' }, { value: 'asc' }, { id: 'asc' }],
  });
}

/**
 * Every buy-order row CardCenter is currently offering. One call for the whole
 * page: rates are never stored, and asking per card would be N live round trips
 * for what is one list on CardCenter's side.
 */
export async function currentRates(userId: number | null): Promise<BuyOrderRate[]> {
  const [emailRow, passwordRow] = await Promise.all([
    getSetting(userId, 'cc_email'),
    getSetting(userId, 'cc_password'),
  ]);
  if (!emailRow?.value || !passwordRow?.value) {
    throw new Error('CardCenter credentials are not configured');
  }
  const res = await ccApiFetch(
    userId, emailRow.value, passwordRow.value,
    '/Api/BuyOrders/v2?organization=&brand=&date=&pageSize=0',
  );
  if (!res.ok) {
    const text = await res.text().catch(() => String(res.status));
    throw new Error(`CardCenter buy orders failed: ${text.slice(0, 200)}`);
  }
  const data = await ccJson<{ items: Array<Record<string, unknown>> }>(res, 'buy orders');
  return (data.items ?? []).map(it => {
    const brand = it.brand as { name?: string } | undefined;
    return {
      id: Number(it.id),
      brandName: String(brand?.name ?? ''),
      value: Number(it.value),
      rate: Number(it.rate),
      availableCap: Number(it.availableCap ?? 0),
    };
  }).filter(r => Number.isFinite(r.id) && r.brandName !== '');
}

/** The waitlisted subset, shaped for the decision core. */
export function waitlistedCards(cards: UnsoldCard[]): WaitlistCardWithBrand[] {
  return cards
    .filter(c => c.waitlistTargetRate != null && c.waitlistMaxDate != null)
    .map(c => ({
      id: c.id,
      merchant: c.merchant,
      value: c.value,
      targetRate: c.waitlistTargetRate as number,
      maxDate: c.waitlistMaxDate as string,
    }));
}

function baseUrl(): string {
  return `http://127.0.0.1:${process.env.PORT ?? 3000}`;
}

async function loopbackPost(path: string, uid: number | null, body: unknown): Promise<void> {
  const secret = process.env.EXTENSION_SHARED_SECRET;
  const res = await fetch(`${baseUrl()}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(uid != null ? { 'X-Extension-User-Id': String(uid) } : {}),
      ...(secret ? { 'X-Extension-Secret': secret } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${path} ${res.status}: ${text.slice(0, 300)}`);
  }
}

/**
 * Run the waitlist for one user. `dryRun` produces the same plan without
 * submitting or writing anything, which is how the page previews a run.
 *
 * Submitting is delegated to the existing reserve route over loopback (the
 * pattern lib/autoSync.ts established): it owns the reserve → poll → submit
 * round trip against CardCenter, and re-implementing that here would be a
 * second money path to keep correct.
 */
export async function runWaitlistForUser(
  userId: number | null,
  opts: { dryRun?: boolean } = {},
): Promise<WaitlistRunResult> {
  const today = todayStamp();
  const dryRun = opts.dryRun === true;
  const summary: WaitlistRunResult = {
    today, dryRun, submitted: [], waiting: [], expired: [], errors: [],
  };

  const onList = waitlistedCards(await unsoldCards(userId));
  if (onList.length === 0) return summary;

  const rates = await currentRates(userId);
  const plan = planWaitlistRun(onList, rates, today);

  // Cards that qualify against the SAME buy order go out as one reservation:
  // CardCenter reserves capacity per buy order, so one call per card would burn
  // a separate reservation for every card of the same brand and denomination.
  const groups = new Map<number, number[]>();
  for (const p of plan) {
    const id = Number(p.card.id);
    if (p.decision === 'SUBMIT' && p.rate) {
      const g = groups.get(p.rate.id);
      if (g) g.push(id); else groups.set(p.rate.id, [id]);
    } else if (p.decision === 'WAIT') {
      summary.waiting.push(id);
    }
  }

  for (const p of plan) {
    if (p.decision !== 'EXPIRE') continue;
    const id = Number(p.card.id);
    if (dryRun) { summary.expired.push(id); continue; }
    try {
      // The card stays unsold and keeps its settings; EXPIRED is what makes the
      // lapse visible on the page instead of silently dropping it.
      await prisma.giftCard.update({
        where: { id },
        data: { waitlistStatus: 'EXPIRED', waitlistUpdatedAt: new Date() },
      });
      summary.expired.push(id);
    } catch (e) {
      summary.errors.push({ id, message: e instanceof Error ? e.message : String(e) });
    }
  }

  for (const [buyOrderId, cardIds] of groups) {
    if (dryRun) { summary.submitted.push(...cardIds); continue; }
    try {
      await loopbackPost('/api/cardcenter/reserve', userId, {
        buyOrderId, quantity: cardIds.length, cardIds,
      });
      await prisma.giftCard.updateMany({
        where: { id: { in: cardIds } },
        data: { waitlistStatus: 'SUBMITTED', waitlistUpdatedAt: new Date() },
      });
      summary.submitted.push(...cardIds);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // One failing buy order must not abandon the others.
      for (const id of cardIds) summary.errors.push({ id, message });
    }
  }

  return summary;
}

/** Users who have opted the unattended runner in. */
async function autoEnabledUsers(): Promise<number[]> {
  const rows = await prisma.setting.findMany({
    where: { key: AUTO_SETTING_KEY, value: 'true' },
    select: { userId: true },
  });
  return rows.map(r => r.userId).filter((u): u is number => u != null);
}

export async function runWaitlistForAllUsers(): Promise<void> {
  let uids: number[];
  try {
    uids = await autoEnabledUsers();
  } catch {
    return;
  }
  for (const uid of uids) {
    try {
      await runWaitlistForUser(uid);
    } catch (e) {
      console.error(`[waitlist] user ${uid} failed:`, e instanceof Error ? e.message : e);
    }
  }
}

/**
 * Hourly unattended run. OPT-IN: a user only gets it after switching
 * `cc_waitlist_auto_enabled` on, because this sells real gift cards without
 * anyone watching. With nobody opted in, the tick is a single cheap query.
 */
export function startWaitlistRunner(): void {
  const tick = () => { void runWaitlistForAllUsers(); };
  setTimeout(() => { tick(); setInterval(tick, RUN_MS); }, BOOT_DELAY_MS);
}
