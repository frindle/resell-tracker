// Returns as the books see them: the same clamp the rest of the app uses (lib/orderReturns.ts), so units returned
// against a line that has since been deleted or cut down never count toward returnedCost shares.
import { clampReturnsToLines, lineKeyOf } from '../returnClamp.ts';
import type { ReturnForBooks } from './orderPostings.ts';

export type RawReturn = ReturnForBooks & { bfmrLinkId: number | null; commitmentLinkId: number | null };

export function clampedReturns(
  returns: RawReturn[],
  bfmrLinks: { id: number; quantity: number }[],
  commitmentLinks: { id: number; quantity: number }[],
): ReturnForBooks[] {
  const lines = [
    ...bfmrLinks.map(l => ({ key: `bfmr:${l.id}`, quantity: l.quantity })),
    ...commitmentLinks.map(l => ({ key: `commit:${l.id}`, quantity: l.quantity })),
  ];
  if (lines.length === 0) {
    const onOrder = returns.filter(r => lineKeyOf(r) === 'order').reduce((s, r) => s + r.quantity, 0);
    lines.push({ key: 'order', quantity: Math.max(1, onOrder) });
  }
  return clampReturnsToLines(returns, lines).map(r => ({
    id: r.id, status: r.status, quantity: r.quantity, refundAmount: r.refundAmount, refundedAt: r.refundedAt,
  }));
}
