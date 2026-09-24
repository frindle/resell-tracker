// Adversarial repo-style test for: rt-emailsync-imap-configurable   (node --test / tsx --test)
//
// Drives the REAL exported fetchOrderEmails from lib/emailSync.ts with a fake
// ImapFlow injected via mock.module BEFORE emailSync is first imported, and
// asserts on the exact constructor config + getMailboxLock argument it produces.
// A plausible-but-wrong fix that keeps the hardcoded imap.gmail.com:993/INBOX
// literals (or applies creds only to some fields) fails at least one case below.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

type CtorCall = { config: Record<string, unknown> };
type FakeState = {
  ctorCalls: CtorCall[];
  lockNames: string[];
  searchResults: number[] | null; // null -> throw on search
  connectError?: Error;
};

// One shared fake instance for the whole file (emailSync binds ImapFlow once at
// import time); each test just resets and drives `state`.
const state: FakeState = { ctorCalls: [], lockNames: [], searchResults: [] };

class ImapFlow {
  config!: Record<string, unknown>;
  constructor(config: Record<string, unknown>) {
    this.config = config;
    state.ctorCalls.push({ config });
  }
  async connect() {
    if (state.connectError) throw state.connectError;
  }
  async getMailboxLock(name: string) {
    state.lockNames.push(name);
    return { release: () => {} };
  }
  async search(_criteria: unknown, _opts?: unknown) {
    if (state.searchResults === null) throw new Error('search should not be reached');
    return state.searchResults;
  }
  async *fetch() { /* never reached when search returns [] */ }
  async logout() {}
}

// Register the mock BEFORE emailSync.ts is first imported (the first dynamic
// import happens inside a test body below), so its top-level
// `import { ImapFlow } from 'imapflow'` binds to this fake.
mock.module('imapflow', { namedExports: { ImapFlow } });

async function load() {
  const mod = await import('./lib/emailSync.ts');
  return mod.fetchOrderEmails;
}

function reset(searchResults: number[] | null, connectError?: Error) {
  state.ctorCalls.length = 0;
  state.lockNames.length = 0;
  state.searchResults = searchResults;
  state.connectError = connectError;
}

test('defaults: omitted fields fall back to today\'s exact Gmail/INBOX behavior', async () => {
  reset([]);
  const fetchOrderEmails = await load();
  const creds = { address: 'shop@gmail.com', appPassword: 'abcd efgh ijkl mnop' };
  const out = await fetchOrderEmails(creds);

  assert.deepEqual(out, []);
  assert.equal(state.ctorCalls.length, 1);
  const cfg = state.ctorCalls[0].config;
  assert.equal(cfg.host, 'imap.gmail.com');
  assert.equal(cfg.port, 993);
  assert.equal(cfg.secure, true);
  assert.deepEqual(cfg.auth, { user: 'shop@gmail.com', pass: 'abcd efgh ijkl mnop' });
  assert.equal(cfg.logger, false);
  assert.deepEqual(state.lockNames, ['INBOX']);
});

test('full override: host/port/secure/mailbox from creds are used verbatim (Proton Bridge)', async () => {
  reset([]);
  const fetchOrderEmails = await load();
  const creds = {
    address: 'bridge@proton.me',
    appPassword: 'x1y2z3w4',
    host: 'mail.proton.me',
    port: 1143,
    secure: false,
    mailbox: 'Orders',
  };
  await fetchOrderEmails(creds);

  const cfg = state.ctorCalls[0].config;
  assert.equal(cfg.host, 'mail.proton.me');
  assert.equal(cfg.port, 1143);
  assert.equal(cfg.secure, false);
  assert.deepEqual(state.lockNames, ['Orders']);
});

test('partial override (over-trigger guard): only mailbox set -> host/port/secure stay at Gmail defaults', async () => {
  reset([]);
  const fetchOrderEmails = await load();
  await fetchOrderEmails({ address: 'a@b.c', appPassword: 'p', mailbox: 'Archive' });

  const cfg = state.ctorCalls[0].config;
  assert.equal(cfg.host, 'imap.gmail.com');
  assert.equal(cfg.port, 993);
  assert.equal(cfg.secure, true);
  assert.deepEqual(state.lockNames, ['Archive']);
});

test('unhappy path: connect() failure propagates and no mailbox lock is ever taken', async () => {
  reset(null, new Error('ECONNREFUSED mail.proton.me:1143'));
  const fetchOrderEmails = await load();
  await assert.rejects(
    () => fetchOrderEmails({ address: 'a@b.c', appPassword: 'p', host: 'mail.proton.me', port: 1143, secure: false }),
    /ECONNREFUSED/,
  );
  assert.equal(state.ctorCalls.length, 1);
  assert.deepEqual(state.lockNames, []);
});
