// Gift card bonus calculation — pure ES module, no side effects.
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
}
