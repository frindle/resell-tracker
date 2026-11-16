import test from 'node:test';
import assert from 'node:assert/strict';
import { extractOtp, bigSkyOtpFromRaw, isBigSkySender, runBigSkyAutoLogin, type AutoLoginDeps } from './bigskyAutoLoginCore.ts';
import { parseRawOrderEmail } from './emailMessage.ts';

function mime(from: string, subject: string, body: string, html = false): string {
  return [
    `From: ${from}`,
    'To: sam@orders.example.test',
    `Subject: ${subject}`,
    'Date: Sun, 15 Nov 2026 20:00:00 +0000',
    'Message-ID: <otp1@mail.example.test>',
    'MIME-Version: 1.0',
    `Content-Type: ${html ? 'text/html' : 'text/plain'}; charset=utf-8`,
    '',
    body,
  ].join('\r\n');
}

// addy.io rewrites the sender as alias+local=domain@alias-domain.
const VIA_ADDY = 'BigSky Buyers <bigsky+noreply=bigskybuyers.com@alias.example.test>';
const CODE_MAIL = mime(VIA_ADDY, 'Your sign-in code', 'Hi,\r\n\r\nYour verification code is: 482913\r\n\r\nIt expires in 5 minutes. Order deals at 100 Test St 00001.');

test('extractOtp: labelled code wins, a lone 6-digit number is taken, ambiguity is refused', () => {
  assert.equal(extractOtp('Your code is 123456. Reply STOP. Ref 654321'), '123456');
  assert.equal(extractOtp('Sign-in code\n\n  777001  \n'), '777001');
  assert.equal(extractOtp('Use 314159 to sign in'), '314159');
  assert.equal(extractOtp('Numbers 111111 and 222222'), null);
  assert.equal(extractOtp('Total $123456.00, order 1234567'), null);
  assert.equal(extractOtp(''), null);
});

test('isBigSkySender matches bigskybuyers.com and its subdomains only', () => {
  assert.ok(isBigSkySender(['noreply@bigskybuyers.com']));
  assert.ok(isBigSkySender(['auth@mail.bigskybuyers.com']));
  assert.ok(!isBigSkySender(['noreply@bigskybuyers.com.evil.test']));
  assert.ok(!isBigSkySender(['bigskybuyers.com@phish.test']));
});

test('bigSkyOtpFromRaw reads the code through an addy.io reverse alias, ignores other senders', async () => {
  assert.equal(await bigSkyOtpFromRaw(CODE_MAIL), '482913');
  assert.equal(await bigSkyOtpFromRaw(mime(VIA_ADDY, 'Sign in', '<p>Your one-time code</p><p><b>905112</b></p>', true)), '905112');
  assert.equal(await bigSkyOtpFromRaw(mime('Shop <noreply@shop.example.test>', 'Your code', 'Your code is 123456')), null);
});

test('a BigSky code email is never offered as an order email', async () => {
  assert.equal(await parseRawOrderEmail(CODE_MAIL, 'm:1', { shared: true }), null);
});

type Msg = { id: string; to: string; raw: string };

function deps(inbox: Msg[], opts: Partial<AutoLoginDeps> & { arriveOnSend?: Msg[] } = {}) {
  let clock = 0;
  const log = { sent: [] as string[], verified: [] as string[], removed: [] as string[] };
  const d: AutoLoginDeps = {
    email: 'bi.alias@relay.example.test',
    inboxAddresses: ['sam@orders.example.test'],
    send: async e => { log.sent.push(e); inbox.push(...(opts.arriveOnSend ?? [])); },
    verify: async (_e, otp) => { log.verified.push(otp); return { cookie: '__Secure-better-auth.session_token=abc', expiresAt: '2026-11-25T00:00:00.000Z' }; },
    list: async () => inbox.map(m => ({ id: m.id, to: m.to })),
    raw: async id => { const m = inbox.find(x => x.id === id); return m ? Buffer.from(m.raw) : null; },
    remove: async ids => { log.removed.push(...ids); },
    now: () => clock,
    sleep: async ms => { clock += ms; },
    ...opts,
  };
  return { d, log };
}

test('auto-login: sends a code request, reads the new code mail, signs in and removes the mail', async () => {
  const old = { id: 'm:old', to: 'sam@orders.example.test', raw: mime(VIA_ADDY, 'Your sign-in code', 'Your code is 111111') };
  const otherUser = { id: 'm:kim', to: 'kim@orders.example.test', raw: mime(VIA_ADDY, 'Your sign-in code', 'Your code is 222222') };
  const fresh = { id: 'm:new', to: 'sam@orders.example.test', raw: CODE_MAIL };
  const { d, log } = deps([old], { arriveOnSend: [otherUser, fresh] });
  const out = await runBigSkyAutoLogin(d);
  assert.equal(out.ok, true);
  assert.deepEqual(log.sent, ['bi.alias@relay.example.test']);
  assert.deepEqual(log.verified, ['482913']); // not the old code, not another user's
  assert.deepEqual(log.removed, ['m:new']);
});

test('auto-login: gives up when no code mail arrives', async () => {
  const { d, log } = deps([], { waitMs: 60_000, pollMs: 10_000 });
  const out = await runBigSkyAutoLogin(d);
  assert.deepEqual(out, { ok: false, reason: 'no-code-email' });
  assert.equal(log.verified.length, 0);
});

test('auto-login: send failure and verify failure are reported, a used code mail is still removed', async () => {
  const { d: d1 } = deps([], { send: async () => { throw new Error('BigSky send OTP 403: captcha'); } });
  const o1 = await runBigSkyAutoLogin(d1);
  assert.equal(o1.ok, false);
  assert.equal(!o1.ok && o1.reason, 'send-failed');

  const fresh = { id: 'm:new', to: 'sam@orders.example.test', raw: CODE_MAIL };
  const { d: d2, log } = deps([], { arriveOnSend: [fresh], verify: async () => { throw new Error('BigSky verify OTP 401'); } });
  const o2 = await runBigSkyAutoLogin(d2);
  assert.equal(!o2.ok && o2.reason, 'verify-failed');
  assert.deepEqual(log.removed, ['m:new']);
});
