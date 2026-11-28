// Pure tests for the bank feed: SimpleFIN client (against a fake local server), OFX parser, dedupe, matching rules.
// No database; the DB-backed tests are in bank.db.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { decimalToCents } from './money.ts';
import { claimSetupToken, decodeSetupToken, fetchAccounts, normalizeAccountSet, dateWindows, kindGuess, last4Guess, SimpleFinError } from './simplefin.ts';
import { parseOfx, ofxDate, OfxError } from './ofx.ts';
import { assignHashIds, planIngest, postedTwin, linksOffAmount, type ExistingTxn } from './dedupe.ts';
import type { BankTxnIn } from './types.ts';
import { budgetAllows, syncRange } from './window.ts';
import { suggestTransfers, suggestCharges, closedTwinPairs, suggestAll, expectedChargeCents, type MatchTxn, type MatchOrder, type MatchAccount } from '../match.ts';

// ---- money ----
test('decimalToCents is exact and handles signs, commas and long fractions', () => {
  assert.equal(decimalToCents('12.34'), 1234);
  assert.equal(decimalToCents('-1,234.5'), -123450);
  assert.equal(decimalToCents('+3.07'), 307);
  assert.equal(decimalToCents('0.10'), 10);
  assert.equal(decimalToCents('5'), 500);
  assert.equal(decimalToCents('abc'), null);
  assert.equal(decimalToCents(''), null);
  assert.equal(decimalToCents(null), null);
});

// ---- SimpleFIN against a fake server ----
const E = (d: string) => Math.floor(Date.parse(`${d}T12:00:00Z`) / 1000);

type Fake = { url: string; hostport: string; claimed: number; gets: { path: string; auth: string | undefined }[]; setBody(b: unknown): void; setStatus(n: number): void; close(): Promise<void>; token: string };
async function fakeServer(): Promise<Fake> {
  let body: unknown = { errlist: [], connections: [], accounts: [] };
  let status = 200;
  const f = { claimed: 0, gets: [] as { path: string; auth: string | undefined }[] } as Fake;
  const srv = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/simplefin/claim/TESTTOKEN') {
      f.claimed++;
      if (f.claimed > 1) { res.statusCode = 403; res.end(); return; }
      res.end(`http://demo-user:demo-pass@127.0.0.1:${(srv.address() as AddressInfo).port}/simplefin`);
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/simplefin/accounts')) {
      f.gets.push({ path: req.url, auth: req.headers.authorization });
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
      return;
    }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  f.hostport = `127.0.0.1:${port}`;
  f.url = `http://${f.hostport}`;
  f.token = Buffer.from(`${f.url}/simplefin/claim/TESTTOKEN`).toString('base64');
  f.setBody = b => { body = b; };
  f.setStatus = n => { status = n; };
  f.close = () => new Promise<void>(r => { srv.closeAllConnections?.(); srv.close(() => r()); });
  return f;
}
const LOCAL = { allowInsecureLocal: true };

test('SimpleFIN: claim once, a second claim is refused with the compromise warning, bad tokens rejected', async () => {
  const f = await fakeServer();
  try {
    const accessUrl = await claimSetupToken(f.token, LOCAL);
    assert.match(accessUrl, /demo-user:demo-pass@127\.0\.0\.1/);
    await assert.rejects(claimSetupToken(f.token, LOCAL), (e: Error) => e instanceof SimpleFinError && e.status === 403 && /someone else may have it/.test(e.message));
  } finally { await f.close(); }
  assert.throws(() => decodeSetupToken(Buffer.from('http://example.com/claim/x').toString('base64')), /https/);
  assert.throws(() => decodeSetupToken('!!not base64 url!!'), SimpleFinError);
  assert.throws(() => decodeSetupToken('   '), /paste/);
});

test('SimpleFIN: accounts sent with Basic auth and window params, errors surfaced, pending kept', async () => {
  const f = await fakeServer();
  try {
    f.setBody({
      errlist: [{ code: 'con.auth', msg: 'Sign in again at the fake bank', conn_id: 'C1' }],
      errors: ['Sign in again at the fake bank', 'You are near the daily request limit'],
      connections: [{ conn_id: 'C1', name: 'Fake Bank', org_id: 'fake.example' }],
      accounts: [{
        id: 'A1', name: 'Everyday Checking (xxxx4321)', conn_id: 'C1', currency: 'USD', balance: '1234.56', 'balance-date': E('2026-11-10'),
        transactions: [
          { id: 'T1', posted: E('2026-11-09'), amount: '-42.10', description: 'COFFEE SHOP #12' },
          { id: 'T2', posted: 0, amount: '-9.99', description: 'STREAMING', pending: true, transacted_at: E('2026-11-10') },
        ],
      }],
    });
    const accessUrl = `http://demo-user:demo-pass@${f.hostport}/simplefin`;
    const r = await fetchAccounts(accessUrl, { startDay: '2026-11-01', endDay: '2026-11-12' }, LOCAL);
    assert.equal(f.gets.length, 1);
    assert.equal(f.gets[0].auth, 'Basic ' + Buffer.from('demo-user:demo-pass').toString('base64'));
    assert.match(f.gets[0].path, /version=2/);
    assert.match(f.gets[0].path, /pending=1/);
    assert.match(f.gets[0].path, new RegExp(`start-date=${Math.floor(Date.parse('2026-11-01T00:00:00Z') / 1000)}`));
    assert.ok(r.errors.some(e => e.code === 'con.auth' && e.connId === 'C1'));
    assert.ok(r.errors.some(e => /daily request limit/.test(e.msg)));
    assert.equal(r.errors.filter(e => /Sign in again/.test(e.msg)).length, 1); // deprecated duplicate not repeated
    const a = r.accounts[0];
    assert.equal(a.kind, 'bank');
    assert.equal(a.last4, '4321');
    assert.equal(a.orgName, 'Fake Bank');
    assert.equal(a.balanceCents, 123456);
    assert.equal(a.balanceDate, '2026-11-10');
    assert.deepEqual(a.transactions.map(t => [t.providerTxnId, t.amountCents, t.pending]), [['T1', -4210, false], ['T2', -999, true]]);
    assert.equal(a.transactions[0].postedDate, '2026-11-09');
  } finally { await f.close(); }
});

test('SimpleFIN: 402, 403 and 500 become readable errors that never contain the credentials', async () => {
  const f = await fakeServer();
  try {
    const accessUrl = `http://sekrit-user:sekrit-pass@${f.hostport}/simplefin`;
    for (const [code, re] of [[402, /payment is required/], [403, /refused the saved access/], [500, /HTTP 500/]] as const) {
      f.setStatus(code);
      await assert.rejects(fetchAccounts(accessUrl, { startDay: '2026-11-01', endDay: '2026-11-02' }, LOCAL), (e: Error) => re.test(e.message) && !/sekrit/.test(e.message + String(e.stack)));
    }
  } finally { await f.close(); }
});

test('SimpleFIN: ranges over 90 days are split into several requests and merged per account', async () => {
  const w = dateWindows('2026-01-01', '2026-11-12');
  assert.ok(w.length >= 4);
  for (const x of w) assert.ok((Date.parse(x.end) - Date.parse(x.start)) / 86400000 <= 90);
  assert.equal(w[0].start, '2026-01-01');
  assert.equal(w[w.length - 1].end, '2026-11-12');
  const f = await fakeServer();
  try {
    f.setBody({ errlist: [], connections: [], accounts: [{ id: 'A1', name: 'Card', conn_id: 'C', currency: 'USD', balance: '-10', 'balance-date': E('2026-11-01'), transactions: [{ id: 'T9', posted: E('2026-03-01'), amount: '-1.00', description: 'x' }] }] });
    const r = await fetchAccounts(`http://u:p@${f.hostport}/simplefin`, { startDay: '2026-01-01', endDay: '2026-11-12' }, LOCAL);
    assert.equal(r.requests, w.length);
    assert.equal(r.accounts.length, 1);
    assert.equal(r.accounts[0].transactions.length, w.length); // same fake row per window; dedupe is the ingest's job
  } finally { await f.close(); }
});

test('SimpleFIN: malformed bodies and helpers', () => {
  assert.throws(() => normalizeAccountSet(null), SimpleFinError);
  assert.equal(kindGuess('Platinum Card', 'American Express'), 'credit');
  assert.equal(last4Guess('Bilt Mastercard (...9876)'), '9876');
  assert.equal(last4Guess('Savings'), null);
});

test('request budget and sync window', () => {
  const now = Date.parse('2026-11-12T20:00:00Z');
  const recent = Array(20).fill(now - 3600_000);
  assert.equal(budgetAllows(recent, now, 4), true);
  assert.equal(budgetAllows(recent, now, 5), false);
  assert.equal(budgetAllows(Array(24).fill(now - 25 * 3600_000), now, 24), true); // old entries age out
  const first = syncRange(null, new Date(now));
  assert.equal(first.endDay, '2026-11-13');
  assert.equal(first.startDay, '2025-11-12');
  const next = syncRange(new Date(now - 86400000), new Date(now));
  assert.equal(next.startDay, '2026-11-06'); // 1 day + 5 days overlap
  assert.equal(dateWindows(next.startDay, next.endDay).length, 1);
});

// ---- OFX ----
const SGML = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>20261110120000<LANGUAGE>ENG<FI><ORG>FAKEBANK<FID>1234</FI></SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<STMTRS><CURDEF>USD
<BANKACCTFROM><BANKID>111000999<ACCTID>000123456789<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20261101<DTEND>20261110
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261103120000[-8:PST]<TRNAMT>-25.50<FITID>20261103001<NAME>GROCERY &amp; DELI<MEMO>CARD PURCHASE</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261105<TRNAMT>1000.00<FITID>20261105001<NAME>PAYROLL</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261106<TRNAMT>-4.00<NAME>VENDING</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261106<TRNAMT>-4.00<NAME>VENDING</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>2345.67<DTASOF>20261110</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>
`;
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<?OFX OFXHEADER="200" VERSION="211" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
<OFX><SIGNONMSGSRSV1><SONRS><FI><ORG>FAKECARD</ORG></FI></SONRS></SIGNONMSGSRSV1>
<CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>USD</CURDEF>
<CCACCTFROM><ACCTID>4111000000009876</ACCTID></CCACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261104</DTPOSTED><TRNAMT>-59.99</TRNAMT><FITID>X1</FITID><NAME>AMZN Mktp US</NAME><MEMO>Order 111-2223334-5556667</MEMO></STMTTRN>
<STMTTRN><TRNTYPE>PAYMENT</TRNTYPE><DTPOSTED>20261108</DTPOSTED><TRNAMT>200.00</TRNAMT><FITID>X2</FITID><NAME>PAYMENT THANK YOU</NAME></STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>-312.40</BALAMT><DTASOF>20261109</DTASOF></LEDGERBAL>
</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;

test('OFX 1.x SGML: transactions, balance, entities, signs, hash ids for rows without FITID', () => {
  const [s] = parseOfx(SGML);
  assert.equal(s.kind, 'bank');
  assert.equal(s.org, 'FAKEBANK');
  assert.equal(s.last4, '6789');
  assert.equal(s.balanceCents, 234567);
  assert.equal(s.balanceDate, '2026-11-10');
  assert.equal(s.transactions.length, 4);
  const [a, b, c, d] = s.transactions;
  assert.equal(a.postedDate, '2026-11-03');
  assert.equal(a.amountCents, -2550);
  assert.equal(a.description, 'GROCERY & DELI');
  assert.equal(a.memo, 'CARD PURCHASE');
  assert.equal(b.amountCents, 100000);
  assert.notEqual(c.providerTxnId, d.providerTxnId); // two identical vending charges stay two rows
  assert.ok(!JSON.stringify(s).includes('000123456789')); // full account number is never kept
  assert.match(s.providerAccountId, /^ofx:[0-9a-f]{16}$/);
});

test('OFX 2.x XML credit card statement', () => {
  const [s] = parseOfx(XML);
  assert.equal(s.kind, 'credit');
  assert.equal(s.last4, '9876');
  assert.equal(s.balanceCents, -31240);
  assert.deepEqual(s.transactions.map(t => [t.amountCents, t.postedDate]), [[-5999, '2026-11-04'], [20000, '2026-11-08']]);
  assert.equal(s.transactions[0].memo, 'Order 111-2223334-5556667');
  assert.ok(!JSON.stringify(s).includes('4111000000009876'));
});

test('OFX: re-parsing gives identical ids so a re-upload inserts nothing; bad input is rejected', () => {
  const ids = (t: string) => parseOfx(t)[0].transactions.map(x => x.providerTxnId);
  assert.deepEqual(ids(SGML), ids(SGML));
  const [s] = parseOfx(SGML);
  const stored: ExistingTxn[] = s.transactions.map((t, i) => ({ id: i + 1, providerTxnId: t.providerTxnId, postedDate: t.postedDate, pending: false, matchStatus: 'unmatched', amountCents: t.amountCents, description: t.description, transactedDate: t.transactedDate }));
  const plan = planIngest(stored, parseOfx(SGML)[0].transactions, null);
  assert.deepEqual([plan.insert.length, plan.update.length, plan.deleteIds.length], [0, 0, 0]);
  assert.throws(() => parseOfx('hello'), OfxError);
  assert.throws(() => parseOfx('<OFX><SIGNONMSGSRSV1></SIGNONMSGSRSV1></OFX>'), OfxError);
  assert.equal(ofxDate('20261103120000[-8:PST]'), '2026-11-03');
  assert.equal(ofxDate('2026'), null);
});

// ---- dedupe ----
const row = (id: string, o: Partial<BankTxnIn> = {}): BankTxnIn => ({
  providerTxnId: id, postedDate: '2026-11-05', transactedDate: null, amountCents: -1000, description: 'X', payee: null, memo: null, pending: false, ...o,
});
const ex = (id: number, p: string, o: Partial<ExistingTxn> = {}): ExistingTxn => ({ id, providerTxnId: p, postedDate: '2026-11-05', pending: false, matchStatus: 'unmatched', amountCents: -1000, description: 'X', transactedDate: null, ...o });

test('hash ids: stable, occurrence-indexed, case/punctuation-insensitive on the description', () => {
  const base = { postedDate: '2026-11-05', transactedDate: null, payee: null, memo: null, pending: false };
  const a = assignHashIds([{ ...base, amountCents: -400, description: 'Vending #1' }, { ...base, amountCents: -400, description: 'VENDING 1' }, { ...base, amountCents: -401, description: 'vending 1' }]);
  assert.equal(new Set(a.map(r => r.providerTxnId)).size, 3);
  const b = assignHashIds([{ ...base, amountCents: -400, description: 'vending 1' }, { ...base, amountCents: -400, description: 'vending 1' }]);
  assert.deepEqual(b.map(r => r.providerTxnId), a.slice(0, 2).map(r => r.providerTxnId));
});

test('ingest plan: new rows insert, same rows are skipped, a pending row that posts is updated in place', () => {
  const stored = [ex(1, 'T1'), ex(2, 'T2', { pending: true, postedDate: '2026-11-09', matchStatus: 'matched' })];
  const plan = planIngest(stored, [row('T1'), row('T2', { pending: false, postedDate: '2026-11-10' }), row('T3')], { windowStart: '2026-11-01', windowEnd: '2026-11-13' });
  assert.deepEqual(plan.insert.map(r => r.providerTxnId), ['T3']);
  assert.deepEqual(plan.update.map(u => [u.id, u.row.pending, u.row.postedDate]), [[2, false, '2026-11-10']]);
  assert.deepEqual(plan.deleteIds, []);
});

test('ingest plan: a vanished unmatched pending row inside the window is deleted; matched or out-of-window ones are kept', () => {
  const stored = [
    ex(1, 'P1', { pending: true, postedDate: '2026-11-09' }),
    ex(2, 'P2', { pending: true, postedDate: '2026-11-09', matchStatus: 'matched' }),
    ex(3, 'P3', { pending: true, postedDate: '2026-01-09' }),
    ex(4, 'S1', { postedDate: '2026-11-09', amountCents: -2500 }), // not a twin of P2: another amount
  ];
  const plan = planIngest(stored, [], { windowStart: '2026-11-01', windowEnd: '2026-11-13' });
  assert.deepEqual(plan.deleteIds, [1]);
  assert.deepEqual(planIngest(stored, [], null).deleteIds, []); // file imports never delete
});

// ---- pending row re-issued under a new id when it posts ----
const W = { windowStart: '2026-11-01', windowEnd: '2026-11-20' };
const pend = (id: number, o: Partial<ExistingTxn> = {}) => ex(id, `P${id}`, { pending: true, postedDate: '2026-11-09', matchStatus: 'matched', description: 'Corner Cafe', ...o });
const cand = (o: Partial<{ amountCents: number; postedDate: string; description: string }> = {}) => ({ amountCents: -1000, postedDate: '2026-11-10', description: 'CORNER CAFE 0042', ...o });

test('postedTwin: same amount and merchant', () => {
  const t = cand();
  assert.equal(postedTwin(pend(1), [cand({ description: 'Other Shop' }), t]), t);
});

test('postedTwin: same merchant at a different amount (a tip)', () => {
  const t = cand({ amountCents: -1200 });
  assert.equal(postedTwin(pend(1), [t]), t);
  assert.equal(postedTwin(pend(1), [cand({ amountCents: 1200 })]), null); // other sign
});

test('postedTwin: same amount within 5 days whatever the description says', () => {
  const t = cand({ description: 'Totally Different', postedDate: '2026-11-12' });
  assert.equal(postedTwin(pend(1), [t]), t);
  assert.equal(postedTwin(pend(1), [cand({ description: 'Totally Different', postedDate: '2026-11-16' })]), null);
});

test('postedTwin: ambiguous or none gives null', () => {
  assert.equal(postedTwin(pend(1), [cand(), cand({ postedDate: '2026-11-11' })]), null);
  assert.equal(postedTwin(pend(1), [cand({ amountCents: -1200 }), cand({ amountCents: -1300 })]), null);
  assert.equal(postedTwin(pend(1), []), null);
});

test('ingest plan: a matched pending row re-issued as a new posted row is rekeyed, keeping its links', () => {
  const plan = planIngest([pend(1)], [row('N1', { postedDate: '2026-11-10', description: 'CORNER CAFE 0042' })], W);
  assert.deepEqual(plan.insert, []);
  assert.deepEqual(plan.update.map(u => [u.id, u.rekey, u.row.providerTxnId, u.row.pending]), [[1, true, 'N1', false]]);
  assert.deepEqual([plan.deleteIds, plan.moves, plan.amountChanged], [[], [], []]);
});

test('ingest plan: a matched pending row whose posted twin was stored earlier moves its links there', () => {
  const stored = [pend(1), ex(2, 'N1', { postedDate: '2026-11-10', description: 'CORNER CAFE 0042' })];
  const plan = planIngest(stored, [], W);
  assert.deepEqual(plan.moves, [{ fromId: 1, toId: 2, tier: 1 }]);
  assert.deepEqual(plan.deleteIds, [1]);
  assert.deepEqual(plan.update, []);
});

test('ingest plan: a matched pending row with no twin is kept; an unmatched one is deleted', () => {
  const plan = planIngest([pend(1), pend(2, { matchStatus: 'unmatched' })], [row('N1', { postedDate: '2026-11-10', amountCents: 5000, description: 'Elsewhere' })], W);
  assert.deepEqual(plan.deleteIds, [2]);
  assert.deepEqual([plan.moves, plan.update], [[], []]);
  assert.deepEqual(plan.insert.map(r => r.providerTxnId), ['N1']);
});

test('ingest plan: a stored same-amount row with another merchant is not claimed; a fresh one is', () => {
  const stored = [pend(1), ex(2, 'N1', { postedDate: '2026-11-10', description: 'Unrelated Store' })];
  const none = planIngest(stored, [], W);
  assert.deepEqual([none.moves, none.deleteIds], [[], []]);
  const fresh = planIngest([pend(1)], [row('N1', { postedDate: '2026-11-10', description: 'Unrelated Store' })], W);
  assert.deepEqual(fresh.update.map(u => [u.id, u.rekey, u.tier]), [[1, true, 3]]);
  const byMerchant = planIngest([pend(1), ex(2, 'N2', { postedDate: '2026-11-10', description: 'CORNER CAFE 7', amountCents: -1300 })], [], W);
  assert.deepEqual(byMerchant.moves, [{ fromId: 1, toId: 2, tier: 2 }]);
});

test('ingest plan: a twin is claimed once; the second pending row has no twin and stays', () => {
  const plan = planIngest([pend(1), pend(2)], [row('N1', { postedDate: '2026-11-10', description: 'CORNER CAFE 0042' })], W);
  assert.equal(plan.update.length + plan.moves.length, 1);
  assert.deepEqual(plan.deleteIds, []);
});

test('ingest plan: amountChanged lists linked rows whose amount changed on posting, rekeyed or in place', () => {
  const tip = planIngest([pend(1)], [row('N1', { postedDate: '2026-11-10', amountCents: -1200, description: 'CORNER CAFE 0042' })], W);
  assert.deepEqual(tip.amountChanged, [{ id: 1, fromCents: -1000, toCents: -1200 }]);
  const inPlace = planIngest([pend(3, { providerTxnId: 'P3' })], [row('P3', { pending: false, postedDate: '2026-11-10', amountCents: -1100, description: 'Corner Cafe' })], W);
  assert.deepEqual(inPlace.amountChanged, [{ id: 3, fromCents: -1000, toCents: -1100 }]);
  const unlinked = planIngest([pend(4, { providerTxnId: 'P4', matchStatus: 'unmatched' })], [row('P4', { pending: false, amountCents: -1100 })], W);
  assert.deepEqual(unlinked.amountChanged, []);
});

test('linksOffAmount: flags linked rows whose links do not add up, ignores shortfall links', () => {
  const t = { amountCents: -1200, matchStatus: 'matched' };
  assert.equal(linksOffAmount(t, [{ kind: 'order_charge', amountCents: 1000 }]), true);
  assert.equal(linksOffAmount(t, [{ kind: 'order_charge', amountCents: 1200 }, { kind: 'payout_shortfall', amountCents: 50 }]), false);
  assert.equal(linksOffAmount({ ...t, matchStatus: 'unmatched' }, [{ kind: 'order_charge', amountCents: 1000 }]), false);
});

// ---- matching ----
const T = (id: number, accountId: number, postedDate: string, amountCents: number, o: Partial<MatchTxn> = {}): MatchTxn => ({ id, accountId, postedDate, amountCents, description: '', matchStatus: 'unmatched', ...o });

test('rule 1: transfers need opposite signs, equal amounts, different accounts, within 5 days', () => {
  const pairs = suggestTransfers([
    T(1, 10, '2026-11-01', -50000), T(2, 20, '2026-11-03', 50000), // pair
    T(3, 10, '2026-11-01', -7000), T(4, 20, '2026-11-07', 7000), // 6 days: no
    T(5, 10, '2026-11-01', -900), T(6, 10, '2026-11-01', 900), // same account: no
    T(7, 10, '2026-11-02', -1100), T(8, 20, '2026-11-02', -1100), // same sign: no
    T(9, 10, '2026-11-02', -2200, { matchStatus: 'ignored' }), T(10, 20, '2026-11-02', 2200), // ignored side: no
  ]);
  assert.equal(pairs.length, 1);
  assert.deepEqual([pairs[0].aId, pairs[0].bId].sort(), [1, 2]);
});

test('rule 1: a card purchase is never a transfer, even when a payout of the same amount lands days later', () => {
  const accts = [{ id: 10, last4: '1111', creditCardId: 7 }, { id: 20, last4: '2222', creditCardId: null }];
  // card 10 charge, then the buyer's payout into account 20: no pair
  assert.deepEqual(suggestTransfers([T(1, 10, '2027-01-16', -45678), T(2, 20, '2027-01-19', 45678)], accts), []);
  // a payment to card 10 from account 20 still pairs
  const pay = suggestTransfers([T(3, 20, '2027-01-16', -50000), T(4, 10, '2027-01-17', 50000)], accts);
  assert.deepEqual(pay.map(p => [p.aId, p.bId]), [[3, 4]]);
});

test('rule 1: a description that names an account pairs only with that account', () => {
  const accts = [{ id: 10, last4: '1111', creditCardId: 7 }, { id: 20, last4: '2222', creditCardId: null }, { id: 30, last4: '3333', creditCardId: null }];
  // checking -> savings, and a card payment of the same amount the same day (its checking side not in yet)
  const pairs = suggestTransfers([
    T(41, 30, '2027-01-25', -80000, { description: 'To Savings 2222' }),
    T(42, 20, '2027-01-25', 80000, { description: 'From Checking 3333' }),
    T(43, 10, '2027-01-25', 80000, { description: 'ONLINE/MOBILE PAYMENT CONF#abc123xyz' }),
  ], accts);
  assert.deepEqual(pairs.map(p => [p.aId, p.bId]), [[41, 42]]);
  // named the other way round: never paired with an account it does not name
  assert.deepEqual(suggestTransfers([T(1, 30, '2027-01-25', -5000, { description: 'To Savings 2222' }), T(2, 10, '2027-01-25', 5000)], accts), []);
});

test('rule 1: closest dates win and each transaction is used once', () => {
  const pairs = suggestTransfers([T(1, 10, '2026-11-05', -1000), T(2, 20, '2026-11-01', 1000), T(3, 20, '2026-11-05', 1000), T(4, 30, '2026-11-04', -1000)]);
  const norm = pairs.map(p => [Math.min(p.aId, p.bId), Math.max(p.aId, p.bId), p.days]).sort();
  assert.deepEqual(norm, [[1, 3, 0], [2, 4, 3]]);
});

const order = (id: number, o: Partial<MatchOrder> = {}): MatchOrder => ({
  id, platform: 'Amazon', orderNumber: null, orderDate: '2026-11-01', cardId: 7, cost: 100, shippingCost: 0, insuranceCost: 0,
  taxAmount: null, subtotalAmount: null, cancelled: false, ...o,
});
const cardAcct: MatchAccount = { id: 10, last4: '1234', creditCardId: null };
const lastFours = new Map([[7, new Set(['1234', '5678'])], [8, new Set(['9999'])]]);

test('rule 2: card last4 + amount + 0-7 day window picks the order; wrong card, day, amount, sign do not', () => {
  const orders = [order(1), order(2, { cardId: 8 }), order(3, { orderDate: '2026-10-20' }), order(4, { cost: 55 })];
  const s = suggestCharges([T(1, 10, '2026-11-03', -10000)], [cardAcct], orders, lastFours);
  assert.equal(s.length, 1);
  assert.deepEqual(s[0].candidates.map(c => c.orderId), [1]);
  assert.equal(suggestCharges([T(1, 10, '2026-11-08', -10000)], [cardAcct], [order(1)], lastFours).length, 1); // day 7
  assert.deepEqual(suggestCharges([T(1, 10, '2026-11-09', -10000)], [cardAcct], [order(1)], lastFours), []); // day 8
  assert.deepEqual(suggestCharges([T(1, 10, '2026-10-31', -10000)], [cardAcct], [order(1)], lastFours), []); // before the order
  assert.deepEqual(suggestCharges([T(1, 10, '2026-11-03', 10000)], [cardAcct], [order(1)], lastFours), []); // a refund is not a charge
});

const ids = (s: ReturnType<typeof suggestCharges>) => s.map(x => [x.txnId, x.candidates.map(c => c.orderId)]);
const shop = { platform: 'Acme', cost: 250, orderDate: '2026-11-02' };

test('rule 2: PayPal and direct charges of one amount split across a PayPal-noted order and a plain one', () => {
  const orders = [order(1, { ...shop }), order(2, { ...shop, paypal: true })];
  const txns = [T(5, 10, '2026-11-03', -25000, { description: 'ACME STORE 555-0100' }), T(6, 10, '2026-11-03', -25000, { description: 'PAYPAL *ACMESTORE 555-0100' })];
  assert.deepEqual(ids(suggestCharges(txns, [cardAcct], orders, lastFours)), [[5, [1]], [6, [2]]]);
  // a lone PayPal charge with no noted order, or a lone direct charge with no plain order, keeps every candidate
  assert.deepEqual(ids(suggestCharges([txns[1]], [cardAcct], [order(1, shop), order(3, shop)], lastFours)), [[6, [1, 3]]]);
  assert.deepEqual(ids(suggestCharges([txns[0]], [cardAcct], [order(2, { ...shop, paypal: true }), order(4, { ...shop, paypal: true })], lastFours)), [[5, [2, 4]]]);
});

test('rule 2: interchangeable twins are paired one-to-one, charge id and order id ascending', () => {
  const orders = [order(9, shop), order(4, shop)];
  const txns = [T(8, 10, '2026-11-03', -25000, { description: 'PAYPAL *ACMESTORE' }), T(7, 10, '2026-11-03', -25000, { description: 'ACME STORE' })];
  assert.deepEqual(ids(suggestCharges(txns, [cardAcct], orders, lastFours)), [[8, [9]], [7, [4]]]);
  // two charges, three identical orders: not a pairing, nothing narrowed
  assert.deepEqual(ids(suggestCharges(txns, [cardAcct], [...orders, order(12, shop)], lastFours)), [[8, [4, 9, 12]], [7, [4, 9, 12]]]);
  // orders that differ (day) are not twins
  assert.deepEqual(ids(suggestCharges(txns, [cardAcct], [order(4, shop), order(9, { ...shop, orderDate: '2026-11-01' })], lastFours)), [[8, [4, 9]], [7, [4, 9]]]);
});

test('rule 2: twins placed the same Los Angeles evening pair even when their UTC days differ', () => {
  // 12:09Z and 03:43Z the next UTC day: both Nov 15 in Los Angeles, but a UTC server gives orderDate 11-15 and 11-16.
  const a = order(1050, { ...shop, orderDate: '2026-11-15', day: '2026-11-15' });
  const b = order(1056, { ...shop, orderDate: '2026-11-16', day: '2026-11-15' });
  const desc = { description: 'ACME STORE 555-0100' };
  const txns = [T(14, 10, '2026-11-16', -25000, desc), T(15, 10, '2026-11-16', -25000, desc)];
  assert.deepEqual(ids(suggestCharges(txns, [cardAcct], [a, b], lastFours)), [[14, [1050]], [15, [1056]]]);
  assert.deepEqual(closedTwinPairs(txns, [cardAcct], [a, b], lastFours), [{ txnId: 14, orderId: 1050 }, { txnId: 15, orderId: 1056 }]);
  // different Los Angeles days are still not twins
  const c = order(1056, { ...shop, orderDate: '2026-11-16', day: '2026-11-16' });
  assert.deepEqual(ids(suggestCharges(txns, [cardAcct], [a, c], lastFours)), [[14, [1050, 1056]], [15, [1050, 1056]]]);
});

test('rule 2: a card still separates what looks like twins', () => {
  const orders = [order(4, shop), order(9, { ...shop, cardId: 8 })];
  const txns = [T(7, 10, '2026-11-03', -25000), T(8, 10, '2026-11-03', -25000)];
  assert.deepEqual(ids(suggestCharges(txns, [cardAcct], orders, lastFours)), [[7, [4]], [8, [4]]]);
});

test('rule 2: one charge and one order, or one charge and two twins, are unchanged', () => {
  assert.deepEqual(ids(suggestCharges([T(1, 10, '2026-11-03', -25000, { description: 'PAYPAL *ACMESTORE' })], [cardAcct], [order(1, shop)], lastFours)), [[1, [1]]]);
  assert.deepEqual(ids(suggestCharges([T(1, 10, '2026-11-03', -25000)], [cardAcct], [order(1, shop), order(2, shop)], lastFours)), [[1, [1, 2]]]);
});

test('rule 2: ship day 0-2 days before the posting narrows several candidates, before twin pairing', () => {
  const a = order(1, { ...shop, shipDay: '2026-11-03' }), b = order(2, { ...shop, shipDay: '2026-11-08' }), c = order(3, shop);
  const t = [T(1, 10, '2026-11-05', -25000)];
  assert.deepEqual(ids(suggestCharges(t, [cardAcct], [a, b, c], lastFours)), [[1, [1]]]);
  // nothing shipped in range: nobody is ruled out; orders with no ship day are never ruled out by this alone
  assert.deepEqual(ids(suggestCharges(t, [cardAcct], [b, c], lastFours)), [[1, [2, 3]]]);
  assert.deepEqual(ids(suggestCharges(t, [cardAcct], [c, order(4, shop)], lastFours)), [[1, [3, 4]]]);
  // shipped after the posting is not in range
  assert.deepEqual(ids(suggestCharges([T(1, 10, '2026-11-05', -25000)], [cardAcct], [order(1, { ...shop, shipDay: '2026-11-06' }), c], lastFours)), [[1, [1, 3]]]);
  // two charges, two orders with different ship days: each charge finds its own
  const two = suggestCharges([T(1, 10, '2026-11-05', -25000), T(2, 10, '2026-11-09', -25000)], [cardAcct], [a, b], lastFours);
  assert.deepEqual(ids(two), [[1, [1]], [2, [2]]]);
});

test('rule 2: a cancelled order is not part of a twin set', () => {
  const orders = [order(1, shop), order(2, shop), order(3, { ...shop, cancelled: true })];
  const txns = [T(1, 10, '2026-11-03', -25000), T(2, 10, '2026-11-03', -25000), T(3, 10, '2026-11-03', -25000)];
  assert.deepEqual(ids(suggestCharges(txns, [cardAcct], orders, lastFours)), [[1, [1, 2]], [2, [1, 2]], [3, [1, 2]]]);
});

test('rule 2: a closed twin set is auto-acceptable; any extra charge, order or cancelled order blocks it', () => {
  const desc = { description: 'ACME STORE 555-0100' };
  const o2 = [order(1, shop), order(2, shop)];
  const t2 = [T(5, 10, '2026-11-03', -25000, desc), T(6, 10, '2026-11-03', -25000, { description: 'PAYPAL *ACMESTORE' })];
  const closed = (txns: MatchTxn[], orders: MatchOrder[]) => closedTwinPairs(txns, [cardAcct], orders, lastFours);
  assert.deepEqual(closed(t2, o2), [{ txnId: 5, orderId: 1 }, { txnId: 6, orderId: 2 }]);
  // a third charge of that amount (the sets are then 3 charges vs 2 orders)
  assert.deepEqual(closed([...t2, T(7, 10, '2026-11-04', -25000, desc)], o2), []);
  // a third order that the charge fits
  assert.deepEqual(closed(t2, [...o2, order(3, { ...shop, orderDate: '2026-11-01' })]), []);
  // a cancelled order of the same kind
  assert.deepEqual(closed(t2, [...o2, order(3, { ...shop, cancelled: true })]), []);
  // a part-paid order is not fully open
  assert.deepEqual(closed(t2, [order(1, shop), order(2, { ...shop, linkedCents: 100 })]), []);
  // an unrelated charge elsewhere does not block
  assert.deepEqual(closed([...t2, T(8, 10, '2026-11-03', -999, { description: 'COFFEE' })], o2).length, 2);
});

test('rule 2: two twin sets on different cards are checked apart', () => {
  const card8: MatchAccount = { id: 12, last4: '9999', creditCardId: null };
  const desc = { description: 'ACME STORE 555-0100' };
  const orders = [order(1, shop), order(2, shop), order(3, { ...shop, cardId: 8 }), order(4, { ...shop, cardId: 8 })];
  const txns = [10, 10, 12, 12].map((acct, i) => T(i + 1, acct, '2026-11-03', -25000, desc));
  const closed = (ts: MatchTxn[]) => closedTwinPairs(ts, [cardAcct, card8], orders, lastFours);
  assert.equal(closed(txns).length, 4);
  // a third charge on card 8 blocks only card 8's set
  assert.deepEqual(closed([...txns, T(9, 12, '2026-11-04', -25000, desc)]), [{ txnId: 1, orderId: 1 }, { txnId: 2, orderId: 2 }]);
});

test('rule 2: a bank account linked to the card matches without last4', () => {
  const linked: MatchAccount = { id: 11, last4: null, creditCardId: 7 };
  assert.equal(suggestCharges([T(1, 11, '2026-11-02', -10000)], [linked], [order(1)], lastFours).length, 1);
});

test('rule 2: tax window when tax is unknown, exact subtotal+tax when both are known', () => {
  const w = expectedChargeCents(order(1));
  assert.deepEqual([w.min, w.max, w.exact], [10000, 11150, false]);
  const k = expectedChargeCents(order(1, { subtotalAmount: 100, taxAmount: 8.25 }));
  assert.deepEqual([k.min, k.max, k.exact], [10825, 10825, true]);
  assert.equal(suggestCharges([T(1, 10, '2026-11-02', -10825)], [cardAcct], [order(1)], lastFours).length, 1); // inside the window
  assert.equal(suggestCharges([T(1, 10, '2026-11-02', -13000)], [cardAcct], [order(1)], lastFours).length, 0); // beyond any sales tax
  const known = order(1, { subtotalAmount: 100, taxAmount: 8.25 });
  assert.equal(suggestCharges([T(1, 10, '2026-11-02', -10000)], [cardAcct], [known], lastFours).length, 0);
  assert.equal(suggestCharges([T(1, 10, '2026-11-02', -10825)], [cardAcct], [known], lastFours).length, 1);
});

test('rule 2: several candidates are all listed; order number then retailer narrow them; taken orders are skipped', () => {
  const orders = [order(1, { orderNumber: '111-2223334-5556667' }), order(2, { orderNumber: '111-9998887-1112223' }), order(3, { platform: 'Walmart' })];
  const t = (desc: string) => [T(1, 10, '2026-11-02', -10000, { description: desc })];
  const ids = (desc: string, taken?: Set<number>) => suggestCharges(t(desc), [cardAcct], orders, lastFours, taken).flatMap(s => s.candidates.map(c => c.orderId)).sort();
  assert.deepEqual(ids('CARD PURCHASE'), [1, 2, 3]);
  assert.deepEqual(ids('AMAZON ORDER 111-9998887-1112223'), [2]);
  assert.deepEqual(ids('AMZN Mktp US*AB12'), [1, 2]);
  assert.deepEqual(ids('WAL-MART #1234'), [3]);
  assert.deepEqual(ids('x', new Set([1, 2])), [3]);
});

test('suggestAll: a card payment is a transfer, claimed before rule 2 can call it an expense', () => {
  const checking: MatchAccount = { id: 20, last4: '0001', creditCardId: null };
  const txns = [T(1, 20, '2026-11-02', -10000, { description: 'CARD PAYMENT' }), T(2, 10, '2026-11-03', 10000, { description: 'PAYMENT THANK YOU' }), T(3, 10, '2026-11-02', -10000, { description: 'AMZN' })];
  const out = suggestAll(txns, [cardAcct, checking], [order(1)], lastFours);
  assert.deepEqual(out.get(1), { kind: 'transfer', txnId: 2 });
  assert.deepEqual(out.get(2), { kind: 'transfer', txnId: 1 });
  assert.deepEqual(out.get(3), { kind: 'order', orderIds: [1] });
});
