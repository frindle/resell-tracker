import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanClientError, shouldLogClientError, CLIENT_ERROR_WINDOW_MS } from './clientErrorReport.ts';

test('cleanClientError keeps strings only, cut short, and drops the query from the path', () => {
  assert.deepEqual(cleanClientError({ path: '/books/bank?review=1', message: "Cannot read properties of undefined (reading 'parts')", stack: 'at a\nat b\n', digest: 7 }), {
    path: '/books/bank', message: "Cannot read properties of undefined (reading 'parts')", stack: 'at a\nat b', digest: '',
  });
  assert.equal(cleanClientError({ message: 'x'.repeat(900) })!.message.length, 300);
  assert.equal(cleanClientError({ message: 'boom' })!.path, '/');
  assert.equal(cleanClientError({ path: '/x' }), null);
  assert.equal(cleanClientError(null), null);
});

test('shouldLogClientError logs a page and message once per window', () => {
  const seen = new Map<string, number>();
  const r = cleanClientError({ path: '/books/bank', message: 'boom' })!;
  assert.equal(shouldLogClientError(seen, r, 1000), true);
  assert.equal(shouldLogClientError(seen, r, 2000), false);
  assert.equal(shouldLogClientError(seen, { ...r, path: '/orders' }, 2000), true);
  assert.equal(shouldLogClientError(seen, r, 1000 + CLIENT_ERROR_WINDOW_MS), true);
});
