#!/usr/bin/env python3
"""Reference impl for: rt-cc-waitlist-core-s1-export-function-decidewa

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
p = wt / 'lib/ccWaitlist.ts'
t = p.read_text()

OLD = r"""// Stub for lib/ccWaitlist.ts -- implement per TASK.md.
export {};"""

NEW = r"""export interface WaitlistCard {
  email: string;
  createdAt: string; // ISO date, e.g. "2026-01-05"
}

export type WaitlistDecision =
  | { action: 'admit'; reason: string }
  | { action: 'reject'; reason: string };

export function decideWaitlist(card: WaitlistCard, currentRate: number, today: string): WaitlistDecision {
  if (currentRate <= 0) return { action: 'reject', reason: `rate ${currentRate} is not positive` };
  if (card.createdAt >= today) return { action: 'reject', reason: `created ${card.createdAt} is not before ${today}` };
  return { action: 'admit', reason: `created ${card.createdAt} precedes ${today} at rate ${currentRate}` };
}"""

assert OLD in t, "refimpl anchor not found -- did the target change?"
p.write_text(t.replace(OLD, NEW, 1))
print("refimpl applied")
