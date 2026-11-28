import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorsVisibleTo } from './apiErrorScope.ts';

test('a user sees their own API errors and the ones logged with no user', () => {
  assert.deepEqual(errorsVisibleTo(7), { OR: [{ userId: 7 }, { userId: null }] });
});
