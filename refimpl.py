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
export interface CardBonusResult {
  times: number;
  points: number;
}

export function calculateCardBonus(
  rule: { points: number; perDollars: number; maxTimes?: number | null },
  spend: number
): CardBonusResult {
  // Validate spend
  if (
    typeof spend !== 'number' ||
    isNaN(spend) ||
    !isFinite(spend) ||
    spend < 0
  ) {
    return { times: 0, points: 0 };
  }

  // Validate rule
  if (
    typeof rule !== 'object' ||
    rule === null ||
    typeof rule.points !== 'number' ||
    isNaN(rule.points) ||
    rule.points < 0 ||
    !isFinite(rule.points) ||
    typeof rule.perDollars !== 'number' ||
    isNaN(rule.perDollars) ||
    rule.perDollars <= 0 ||
    !isFinite(rule.perDollars)
  ) {
    return { times: 0, points: 0 };
  }

  // Validate maxTimes
  const rawMaxTimes = rule.maxTimes;
  if (rawMaxTimes !== undefined && rawMaxTimes !== null) {
    if (typeof rawMaxTimes !== 'number' || isNaN(rawMaxTimes) || rawMaxTimes < 0) {
      return { times: 0, points: 0 };
    }
  }

  const maxTimes = (rawMaxTimes !== undefined && rawMaxTimes !== null)
    ? Math.floor(rawMaxTimes)
    : Infinity;

  if (maxTimes < 0) {
    return { times: 0, points: 0 };
  }

  const times = Math.min(Math.floor(spend / rule.perDollars + 1e-10), maxTimes);
  const points = times * rule.points;

  return { times, points };
}"""

assert OLD in t, "refimpl anchor not found -- did the target change?"
p.write_text(t.replace(OLD, NEW, 1))
print("refimpl applied")
