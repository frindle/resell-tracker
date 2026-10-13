#!/usr/bin/env python3
"""Reference implementation writer for lib/cardBonuses.ts"""

import os
import sys


def main():
    worktree = sys.argv[1] if len(sys.argv) > 1 else '.'
    target = os.path.join(worktree, 'lib', 'cardBonuses.ts')

    # Read existing content (stub)
    old = ""
    if os.path.exists(target):
        with open(target, 'r') as f:
            old = f.read()

    # Write the implementation, replacing the stub
    new_content = r'''export type CardBonusResult = {
  bonusTier: 'none' | 'bronze' | 'silver' | 'gold';
  bonusAmount: number;
};

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
}
'''

    with open(target, 'w') as f:
        f.write(new_content)


if __name__ == '__main__':
    main()
