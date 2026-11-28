import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MOVE_ACTIONS, MOVE_ACCOUNT, MOVE_MEMO, isMove, moveRefusal } from './moves.ts';

test('isMove accepts only the four move actions', () => {
  for (const a of MOVE_ACTIONS) assert.equal(isMove(a), true);
  for (const a of ['accept', 'cost', 'personal', '', 'Darkbloom']) assert.equal(isMove(a), false);
});

test('credits: a Darkbloom payout and interest need a credit', () => {
  for (const a of ['darkbloom', 'interest'] as const) {
    assert.equal(moveRefusal(a, 5000, true), null);
    assert.equal(moveRefusal(a, -5000, true)?.status, 400);
    assert.equal(moveRefusal(a, 0, true)?.status, 400);
  }
});

test('debits: a Darkbloom top-up and cost need a debit', () => {
  for (const a of ['darkbloom_topup', 'darkbloom_cost'] as const) {
    assert.equal(moveRefusal(a, -5000, true), null);
    assert.equal(moveRefusal(a, 5000, true)?.status, 400);
    assert.equal(moveRefusal(a, 0, true)?.status, 400);
  }
});

test('an account not in the books is refused with 409, after the sign check', () => {
  assert.equal(moveRefusal('darkbloom', 5000, false)?.status, 409);
  assert.equal(moveRefusal('darkbloom_topup', -5000, false)?.status, 409);
  assert.equal(moveRefusal('darkbloom', -5000, false)?.status, 400);
});

test('each action posts against its own fixed ledger account with a memo', () => {
  assert.deepEqual(MOVE_ACCOUNT, { darkbloom: 'darkbloom_balance', darkbloom_topup: 'owner_contributions', darkbloom_cost: 'due_to_owner', interest: 'interest_income' });
  for (const a of MOVE_ACTIONS) assert.ok(MOVE_MEMO[a].length > 0);
  assert.equal(new Set(Object.values(MOVE_ACCOUNT)).size, MOVE_ACTIONS.length);
});
