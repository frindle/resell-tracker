// One-link bank actions on a mapped account that move money between that account and a fixed ledger account:
// a Darkbloom payout, a Darkbloom top-up, a Darkbloom cost paid from this account, interest earned. Pure, so the
// action handler, the rule matcher and the row buttons agree on when each is allowed.

export const MOVE_ACTIONS = ['darkbloom', 'darkbloom_topup', 'darkbloom_cost', 'interest'] as const;
export type MoveAction = (typeof MOVE_ACTIONS)[number];

/** +1: the row must be a credit; -1: a debit. */
const SIGN: Record<MoveAction, 1 | -1> = { darkbloom: 1, darkbloom_topup: -1, darkbloom_cost: -1, interest: 1 };
const WHAT: Record<MoveAction, string> = {
  darkbloom: 'a Darkbloom payout is a credit',
  darkbloom_topup: 'a Darkbloom top-up is a debit',
  darkbloom_cost: 'a Darkbloom cost is a debit',
  interest: 'interest earned is a credit',
};

export const isMove = (a: string): a is MoveAction => (MOVE_ACTIONS as readonly string[]).includes(a);

/** Why `action` cannot link this row, or null. */
export function moveRefusal(action: MoveAction, amountCents: number, mapped: boolean): { status: 400 | 409; error: string } | null {
  if (Math.sign(amountCents) !== SIGN[action]) return { status: 400, error: WHAT[action] };
  if (!mapped) return { status: 409, error: 'this account is not in your books; map it first' };
  return null;
}

/**
 * The other side of the posting (the row's own account is the first side). A top-up and a cost are entered in
 * bloom-ledger as well, where the monthly tally books them as paid by the owner (Owner contributions, Due to owner);
 * paying them from a books account moves that onto the account, so the two together say "paid from this account".
 */
export const MOVE_ACCOUNT: Record<MoveAction, string> = {
  darkbloom: 'darkbloom_balance', darkbloom_topup: 'owner_contributions', darkbloom_cost: 'due_to_owner', interest: 'interest_income',
};
export const MOVE_MEMO: Record<MoveAction, string> = {
  darkbloom: 'Darkbloom payout', darkbloom_topup: 'Darkbloom top-up paid from this account', darkbloom_cost: 'Darkbloom cost paid from this account',
  interest: 'Interest earned',
};
