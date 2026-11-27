import { prisma } from '@/lib/db';
import { getBgAccessToken } from '@/lib/bgAuth';
import { getCommitments, editCommitment, type BGCommitment } from '@/lib/buyinggroup';
import { bgStateFrom, planBgReduce, type BgOutcome, type BgState } from '@/lib/cancelReducePlan';

// The executor for lib/cancelReducePlan.ts's BG plan: reads the commitment's
// quantity from BG, and when the user's setting is on, lowers it. Never throws.

export type BgReleased = { commitmentId: number; name: string; quantity: number };

/** BG's side, swappable so tests never reach BG. */
export type BgDeps = {
  /** Every commitment BG lists, by BG's id; null when BG can't be read. */
  read: (userId: number) => Promise<Map<string, BGCommitment> | null>;
  edit: (userId: number, dealKey: string, itemKey: string, quantity: number) => Promise<unknown>;
};

const realDeps: BgDeps = {
  read: liveCommitments,
  edit: async (userId, dealKey, itemKey, quantity) => editCommitment(await getBgAccessToken(userId), dealKey, itemKey, quantity),
};

/** Every commitment BG lists, by BG's commitment id. Empty map when BG can't be read. */
async function liveCommitments(userId: number): Promise<Map<string, BGCommitment> | null> {
  try {
    const token = await getBgAccessToken(userId);
    const byId = new Map<string, BGCommitment>();
    for (let page = 1; page <= 50; page++) {
      const { commitments, count } = await getCommitments(token, page, 100);
      const fresh = commitments.filter(c => !byId.has(c.commitment_id));
      for (const c of fresh) byId.set(c.commitment_id, c);
      if (!commitments.length || !fresh.length || (count != null && byId.size >= count)) break;
    }
    return byId;
  } catch (e) {
    console.error(`[cancel-reduce] BG read failed for user ${userId}:`, String(e).slice(0, 160));
    return null;
  }
}

function syncedState(raw: string | null, count: number): BgState | null {
  try {
    return bgStateFrom(raw ? JSON.parse(raw) : null, count, 'synced');
  } catch {
    return null;
  }
}

/**
 * Lowers each commitment by the units the cancel released. Plans always;
 * calls BG only when `enabled` and the quantity was read live from BG (a stale
 * synced row is good enough to say what would happen, not to edit with).
 */
export async function reduceBgCommitments(userId: number, released: readonly BgReleased[], enabled: boolean, now = new Date(), deps: BgDeps = realDeps): Promise<BgOutcome[]> {
  const out: BgOutcome[] = [];
  if (!released.length) return out;
  try {
    const rows = await prisma.buyingGroupCommitment.findMany({
      where: { userId, id: { in: released.map(r => r.commitmentId) } },
      select: { id: true, commitmentId: true, count: true, price: true, raw: true },
    });
    const live = await deps.read(userId);
    for (const r of released) {
      const row = rows.find(x => x.id === r.commitmentId);
      if (!row) { out.push({ name: r.name, state: 'skipped', reason: 'commitment not in the tracker' }); continue; }
      // Live units held by other orders that are still alive (the cancelled order's links are gone or cut).
      const held = await prisma.orderCommitmentLink.aggregate({ where: { commitmentId: row.id, order: { cancelled: false } }, _sum: { quantity: true } });
      const stillLinked = held._sum.quantity ?? 0;
      const liveRec = live?.get(row.commitmentId);
      const bg = liveRec ? bgStateFrom(liveRec, liveRec.count, 'live') : syncedState(row.raw, row.count);
      const plan = planBgReduce({ released: r.quantity, stillLinked, bg, now });
      if (plan.kind === 'skip') { out.push({ name: r.name, state: 'skipped', from: plan.from, reason: plan.reason }); continue; }
      if (!enabled) { out.push({ name: r.name, state: 'would', from: plan.from, to: plan.to }); continue; }
      if (plan.source !== 'live') { out.push({ name: r.name, state: 'skipped', from: plan.from, reason: 'BG could not be read just now' }); continue; }
      try {
        await deps.edit(userId, plan.dealKey, plan.itemKey, plan.to);
        await prisma.buyingGroupCommitment.update({ where: { id: row.id }, data: { count: plan.to, total: Math.round(row.price * plan.to * 100) / 100 } });
        out.push({ name: r.name, state: 'reduced', from: plan.from, to: plan.to });
      } catch (e) {
        console.error(`[cancel-reduce] BG edit failed for user ${userId}:`, String(e).slice(0, 160));
        out.push({ name: r.name, state: 'failed', from: plan.from, to: plan.to, reason: 'the BG call failed' });
      }
    }
  } catch (e) {
    console.error(`[cancel-reduce] failed for user ${userId}:`, String(e).slice(0, 160));
    for (const r of released) if (!out.some(o => o.name === r.name)) out.push({ name: r.name, state: 'failed', reason: 'it could not be planned' });
  }
  const n = (s: BgOutcome['state']) => out.filter(o => o.state === s).length;
  console.log(`[cancel-reduce] bg reduced=${n('reduced')} would=${n('would')} skipped=${n('skipped')} failed=${n('failed')} user=${userId}`);
  return out;
}
