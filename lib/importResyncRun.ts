import { prisma } from '@/lib/db';
import { resyncBeforeMatch, type ResyncSource } from '@/lib/importResync';
import { syncBgCommitments } from '@/lib/bgCommitmentSync';
import { syncBigSkyCommitments } from '@/lib/bigskyCommitmentSync';
import { syncBfmrReservations } from '@/lib/bfmrReservationSync';

// Refreshes BG, BigSky and BFMR rows for one user before the import's commitment match
// (see lib/importResync.ts). BFMR uses the narrow 'order-open' pull (no web backfill).
export function resyncCommitmentSources(userId: number) {
  const newest = async (source: ResyncSource): Promise<number | null> => {
    const where = { userId };
    const agg = source === 'bg' ? await prisma.buyingGroupCommitment.aggregate({ where, _max: { lastSyncedAt: true } })
      : source === 'bigsky' ? await prisma.bigSkyCommitment.aggregate({ where, _max: { lastSyncedAt: true } })
      : await prisma.bfmrReservation.aggregate({ where, _max: { lastSyncedAt: true } });
    return agg._max.lastSyncedAt?.getTime() ?? null;
  };
  return resyncBeforeMatch(userId, {
    lastSyncedMs: newest,
    run: source => source === 'bg' ? syncBgCommitments(userId)
      : source === 'bigsky' ? syncBigSkyCommitments(userId)
      : syncBfmrReservations(userId, null, 'order-open'),
  });
}
