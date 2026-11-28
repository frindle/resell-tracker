// Pairing two bank rows by hand as a transfer between the user's own accounts.

type PairRow = { id: number; bankAccountId: number; amountCents: number; matchStatus: string };
/** Why two rows cannot be paired by hand as a transfer, or null when they can. */
export function transferRefusal(t: PairRow, p: PairRow | null): string | null {
  if (!p) return 'no bank row with that number';
  if (p.id === t.id) return 'pick the other side of the transfer, not this row';
  if (p.matchStatus !== 'unmatched' && p.matchStatus !== 'suggested') return `row #${p.id} is already linked; undo it first`;
  if (p.bankAccountId === t.bankAccountId) return 'a transfer is between two different accounts';
  if (Math.sign(p.amountCents) === Math.sign(t.amountCents) || Math.abs(p.amountCents) !== Math.abs(t.amountCents)) {
    return `row #${p.id} is not the same amount going the other way`;
  }
  return null;
}
