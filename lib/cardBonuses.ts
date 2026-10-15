// Gift card bonus calculation — pure ES module, no side effects.
export interface CardBonusResult {
  times: number;
  points: number;
}

export interface CardBonusRule {
  points: number;
  perDollars: number;
  maxTimes?: number | null;
}

export function calculateCardBonus(
  rule: CardBonusRule | null | undefined,
  spend: number,
): CardBonusResult {
  // Validate spend: must be a finite number
  if (typeof spend !== 'number' || !Number.isFinite(spend)) {
    return { times: 0, points: 0 };
  }
  if (spend < 0) {
    return { times: 0, points: 0 };
  }

  // Validate rule
  if (rule === null || rule === undefined) {
    return { times: 0, points: 0 };
  }

  const { points, perDollars, maxTimes } = rule;

  // Validate perDollars: must be a finite number > 0
  if (typeof perDollars !== 'number' || !Number.isFinite(perDollars) || perDollars <= 0) {
    return { times: 0, points: 0 };
  }

  // Validate points: must be a finite number >= 0
  if (typeof points !== 'number' || !Number.isFinite(points) || points < 0) {
    return { times: 0, points: 0 };
  }

  // Validate maxTimes (optional)
  let cap: number;
  if (maxTimes === null || maxTimes === undefined) {
    cap = Infinity;
  } else if (typeof maxTimes !== 'number' || !Number.isFinite(maxTimes)) {
    // NaN, string, etc. — invalid cap
    return { times: 0, points: 0 };
  } else if (maxTimes < 0) {
    return { times: 0, points: 0 };
  } else {
    cap = Math.floor(maxTimes);
    if (cap < 0) {
      return { times: 0, points: 0 };
    }
  }

  // Compute earned times: floor(spend / perDollars + 1e-9) to avoid floating-point under-count
  const earned = Math.floor(spend / perDollars + 1e-9);

  // Apply cap: max(0, min(earned, cap))
  const times = Math.max(0, Math.min(earned, cap));

  // Compute points
  const pointsEarned = times * (rule.points);

  // If points would overflow to Infinity, return zero
  if (!Number.isFinite(pointsEarned)) {
    return { times: 0, points: 0 };
  }

  return { times, points: pointsEarned };
}
