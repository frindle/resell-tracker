#!/usr/bin/env python3
"""Reference impl for: cardBonuses-v2

The gate applies this, runs the verify, and reverts it. It proves two things at
once: the task is SATISFIABLE as specified, and the verify actually ENFORCES the
spec (a refimpl that goes green while a "Must contain" literal is absent means
the verify is benign).

Write the SIMPLEST change that makes the verify pass. It doubles as your review
reference when the model's diff comes back.
"""
import pathlib
import sys

wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / 'lib/cardBonuses.ts'
t = p.read_text()

OLD = """// Gift card bonus calculation — pure ES module, no side effects.
export interface CardBonusResult {
  bonusTier: string;
  bonusAmount: number;
}

export function calculateCardBonus(cardValue: number): CardBonusResult {
  if (cardValue < 10) {
    return { bonusTier: 'none', bonusAmount: 0 };
  }
  if (cardValue < 50) {
    return { bonusTier: 'bronze', bonusAmount: cardValue * 0.05 };
  }
  if (cardValue < 100) {
    return { bonusTier: 'silver', bonusAmount: cardValue * 0.1 };
  }
  return { bonusTier: 'gold', bonusAmount: cardValue * 0.2 };
}"""

NEW = r"""// Gift card bonus calculation — pure ES module, no side effects.
// User-configured rule: earn `points` per `perDollars` spent, up to `maxTimes` times.
export interface CardBonusResult {
  times: number;
  points: number;
}

export function calculateCardBonus(
  rule: { points: number; perDollars: number; maxTimes?: number | null },
  spend: number
): CardBonusResult {
  const none: CardBonusResult = { times: 0, points: 0 };
  if (rule === null || rule === undefined) return none;
  if (!Number.isFinite(spend)) return none;
  if (!Number.isFinite(rule.points) || rule.points < 0) return none;
  if (!Number.isFinite(rule.perDollars) || rule.perDollars <= 0) return none;
  let cap = Infinity;
  if (rule.maxTimes !== null && rule.maxTimes !== undefined) {
    if (typeof rule.maxTimes !== 'number' || Number.isNaN(rule.maxTimes)) return none;
    cap = Math.floor(rule.maxTimes);
  }
  // epsilon: 0.3 / 0.1 is 2.9999999999999996 in floating point
  const earned = Math.floor(spend / rule.perDollars + 1e-9);
  const times = Math.max(0, Math.min(earned, cap));
  const points = times * rule.points;
  if (!Number.isFinite(points)) return none;
  return { times, points };
}"""

assert OLD in t, "refimpl anchor not found -- did the target change?"
p.write_text(t.replace(OLD, NEW, 1))
print("refimpl applied")
