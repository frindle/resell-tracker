// Order-level bfmrStatus from its sold links, PROMOTE ONLY: never moves an
// order backwards from what sync established. Every sold leg paid -> 'paid'
// (order 900 sat at 'shipped' with both legs paid); every leg at least
// shipped -> 'shipped'.
export function rollUpBfmrStatus(
  linkRanks: number[],
  currentRank: number,
  shippedRank: number,
  paidRank: number,
): 'paid' | 'shipped' | null {
  if (linkRanks.length === 0) return null;
  const min = Math.min(...linkRanks);
  if (min >= paidRank && currentRank < paidRank) return 'paid';
  if (min >= shippedRank && currentRank < shippedRank) return 'shipped';
  return null;
}
