import type { BgExpiry } from './emailNoise.ts';

// What BuyingGroup's "Deal Expired" notice does to the tracker's commitments
// (BuyingGroupCommitment, synced from BuyingGroup's API). When some items were
// already received BuyingGroup splits the commitment: the original keeps the
// received quantity, a new remainder commitment carries the rest and expires.
// The next BuyingGroup sync brings the true state; this applies the notice now
// so the expired quantity stops counting as open. Pure, no I/O.

export const EXPIRED = 'EXPIRED';

export type CommitmentRow = { id: number; commitmentId: string; status: string; count: number; price: number };

export type ExpiryAction =
  | { kind: 'expire'; id: number }
  | { kind: 'shrink'; id: number; count: number; total: number }
  | { kind: 'already' }
  | { kind: 'none' };

export function planCommitmentExpiry(e: Pick<BgExpiry, 'originalId' | 'originalQuantity' | 'expiredId'>, rows: readonly CommitmentRow[]): ExpiryAction {
  const expired = rows.find(r => r.commitmentId === e.expiredId);
  if (expired) return expired.status.toUpperCase() === EXPIRED ? { kind: 'already' } : { kind: 'expire', id: expired.id };
  // The remainder is not synced yet: cut the original back to what was received.
  const original = e.originalId ? rows.find(r => r.commitmentId === e.originalId) : undefined;
  if (original && e.originalQuantity != null && e.originalQuantity > 0) {
    if (original.count <= e.originalQuantity) return { kind: 'already' };
    return { kind: 'shrink', id: original.id, count: e.originalQuantity, total: Math.round(original.price * e.originalQuantity * 100) / 100 };
  }
  return { kind: 'none' };
}
