// BuyingGroup commitment reduction: compute which commitments to lower when a
// linked order is cancelled.

export type ReduceLink = {commitmentId:number;quantity:number};

export type ReduceCommitment = {id:number;dealKey:string;itemKey:string;count:number;fulfilled:number};

export type CommitmentReduction = {commitmentId:number;dealKey:string;itemKey:string;from:number;to:number;linkedQuantity:number;clampedToFulfilled:boolean};

export function computeCommitmentReductions(
  order: { cancelled: boolean; links: ReduceLink[] },
  commitments: ReduceCommitment[],
): CommitmentReduction[] {
  if (!order.cancelled) {
    return [];
  }

  // Build a lookup map from commitment id to the commitment object.
  const commitmentMap = new Map<number, ReduceCommitment>();
  for (const c of commitments) {
    commitmentMap.set(c.id, c);
  }

  // Group links by commitmentId, summing quantities (ignore quantity <= 0).
  const sums = new Map<number, number>();
  for (const link of order.links) {
    if (link.quantity <= 0) {
      continue;
    }
    const existing = sums.get(link.commitmentId) || 0;
    sums.set(link.commitmentId, existing + link.quantity);
  }

  // Build the result array.
  const result: CommitmentReduction[] = [];
  for (const [commitmentId, linkedQuantity] of sums) {
    const commitment = commitmentMap.get(commitmentId);
    if (!commitment) {
      continue;
    }

    const from = commitment.count;
    const unclamped = from - linkedQuantity;
    const clamped = Math.max(unclamped, commitment.fulfilled, 0);
    const clampedToFulfilled = unclamped < commitment.fulfilled;

    if (clamped === from) {
      continue; // no-op
    }

    result.push({
      commitmentId,
      dealKey: commitment.dealKey,
      itemKey: commitment.itemKey,
      from,
      to: clamped,
      linkedQuantity,
      clampedToFulfilled,
    });
  }

  // Sort by commitmentId ascending.
  result.sort((a, b) => a.commitmentId - b.commitmentId);

  return result;
}
