/** An account can be hidden only while it is not in the books (no card and no ledger account). Returns the refusal text, or null when the state is allowed. */
export function hideRefusal(a: { hidden: boolean; creditCardId: number | null; ledgerAccountId: number | null }): string | null {
  if (!a.hidden) return null;
  if (a.creditCardId != null || a.ledgerAccountId != null) return 'an account that is in your books (linked to a card or a ledger account) cannot be hidden';
  return null;
}
