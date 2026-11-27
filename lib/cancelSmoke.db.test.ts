// End-to-end smoke test of what a cancellation email does to BuyingGroup (BG) and BFMR, with the
// cancel_reduce_groups setting off (shadow mode) and on. It runs the real path, runEmailAutoImport:
// the inbox list and fetch, the MIME parse, the plan, applyCancels, the DB writes and the Pushover
// text, against a fresh SQLite file. Every outward call (inbox, BG, BFMR, Pushover) goes to one fake
// fetch that records it, so nothing leaves the process. Synthetic data only.
//
//   npm run test:cancel-smoke-db            (needs `prisma generate`)
//   SMOKE_LOG=1 npm run test:cancel-smoke-db   also prints every request and each case's end state
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'cancel-smoke-db-'));
process.env.DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: process.env, stdio: 'pipe' });

// ---------------------------------------------------------------------------
// The fake world: one fetch for the inbox worker, BG, BFMR and Pushover
// ---------------------------------------------------------------------------

type Req = { who: 'inbox' | 'bg' | 'bfmr' | 'pushover' | 'other'; method: string; path: string; body: unknown; write: boolean };
const reqs: Req[] = [];
const inbox = new Map<string, { raw: string; receivedAt: string }>();
const bgRecs = new Map<string, Record<string, unknown>>();
const bg = { failRead: false, failEdit: false };
const bfmr = { invalid: [] as string[], fail: false };
const pushes: string[] = [];

const CF = 'http://inbox.test';
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? 'GET').toUpperCase();
  const raw = typeof init?.body === 'string' ? init.body : null;
  let body: unknown = raw;
  try { body = raw ? JSON.parse(raw) : null; } catch { /* form-encoded */ }
  const rec = (who: Req['who'], write: boolean) => reqs.push({ who, method, path: url.pathname, body, write });
  if (url.origin === CF) {
    rec('inbox', method === 'DELETE');
    if (method === 'DELETE') { inbox.delete(decodeURIComponent(url.pathname.split('/').pop()!)); return json({ ok: true }); }
    if (url.pathname === '/archive') return json({ messages: [], cursor: null, complete: true });
    if (url.pathname === '/messages') {
      const messages = [...inbox].map(([id, m]) => ({ id, to: 'inbox@example.test', from: 'help@walmart.com', size: m.raw.length, receivedAt: m.receivedAt }));
      return json({ messages, cursor: null, complete: true });
    }
    const m = inbox.get(decodeURIComponent(url.pathname.split('/').pop()!));
    return m ? new Response(m.raw) : new Response('', { status: 404 });
  }
  if (url.host === 'api.prod.buyinggroup.com') {
    if (url.pathname === '/v2/token/refresh') { rec('bg', false); return json({ access: 'fake-access' }); }
    if (url.pathname === '/v1/commitment/get_commitments') {
      rec('bg', false);
      return bg.failRead ? json({ error: 'down' }, 500) : json({ status: 'SUCCESS', payload: { commitments: [...bgRecs.values()], count: bgRecs.size } });
    }
    if (url.pathname === '/v1/commitment/edit_commitment') {
      rec('bg', true);
      if (bg.failEdit) return json({ error: 'nope' }, 500);
      const b = body as { deal_key: string; item_key: string; quantity: number };
      for (const r of bgRecs.values()) if ((r.deal as { key: string }).key === b.deal_key) r.count = b.quantity;
      return json({ status: 'SUCCESS' });
    }
    rec('bg', true);
    return json({}, 404);
  }
  if (url.host === 'api.bfmr.com') {
    const cancel = url.pathname === '/api/v2/my-tracker/reservation/cancel';
    rec('bfmr', method !== 'GET');
    if (cancel && !bfmr.fail) return json({ message: 'ok', invalid_reservations: bfmr.invalid });
    return json({}, bfmr.fail ? 500 : 404);
  }
  if (url.host === 'api.pushover.net') {
    rec('pushover', false);
    pushes.push(String(new URLSearchParams(raw ?? '').get('message')));
    return json({ status: 1 });
  }
  rec('other', method !== 'GET');
  return json({}, 404);
}) as typeof fetch;

const { prisma, upsertSetting } = await import('./db.ts');
const { runEmailAutoImport } = await import('./emailAutoImport.ts');
const { CANCEL_REDUCE_KEY } = await import('./cancelReducePlan.ts');

let userId = 0;
before(async () => {
  userId = (await prisma.user.create({ data: { name: 'cancel-smoke' } })).id;
  assert.equal(userId, 1);
  await upsertSetting(null, 'email_inbox_mode', 'cloudflare');
  await upsertSetting(null, 'email_cf_url', CF);
  await upsertSetting(null, 'email_cf_token', 'fake-token');
  for (const [k, v] of Object.entries({ bg_refresh_token: 'fake-refresh', bfmr_api_key: 'fake-key', bfmr_api_secret: 'fake-secret', pushover_user_key: 'fake-user', pushover_app_token: 'fake-app' })) await upsertSetting(userId, k, v);
});
after(async () => { await prisma.$disconnect(); rmSync(dir, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// Fixtures: a Walmart cancellation email in the parser's real format (see emailParse.test.ts).
// The item's quantity comes from the image alt text, as the parser reads it: "(xN)" only when N > 1.
// ---------------------------------------------------------------------------

type CancelMail = { order: string; item: string; qty?: number; amount: number; date?: string | null; whole?: boolean };
function cancelMail(m: CancelMail): string {
  const text = [
    `Order number: ${m.order}`,
    m.whole ? 'Your order has been canceled' : 'Some items were canceled',
    `${m.qty ?? 1} items canceled`, m.item, `Qty: ${m.qty ?? 1}`, 'Temporary hold released', 'VISA ending in 0000', `$${m.amount.toFixed(2)}`, '',
  ].join('\r\n');
  const html = `<html><body><p>Order number: ${m.order}</p><p>${m.whole ? 'Your order has been canceled' : 'Some items were canceled'}</p><img alt="quantity ${m.qty ?? 1} item ${m.item}" src="https://img.example.test/a.png"><p>Temporary hold released</p><p>VISA ending in 0000</p><p>$${m.amount.toFixed(2)}</p></body></html>`;
  const b = 'smokeboundary';
  const date = m.date === null ? [] : [`Date: ${m.date ?? 'Mon, 23 Nov 2026 15:00:00 +0000'}`];
  return [
    'From: help@walmart.com', 'To: inbox@example.test', `Subject: Canceled: ${m.item}...`, ...date,
    `Message-ID: <${Math.random().toString(36).slice(2)}@mail.example.test>`, 'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${b}"`, '',
    `--${b}`, 'Content-Type: text/plain; charset=utf-8', '', text, `--${b}`, 'Content-Type: text/html; charset=utf-8', '', html, `--${b}--`, '',
  ].join('\r\n');
}

let seq = 0;
const nextId = () => `msg-${++seq}`;
/** Puts the email in the inbox and runs the real import over it. */
async function deliver(m: CancelMail, id = nextId()) {
  inbox.set(id, { raw: cancelMail(m), receivedAt: new Date().toISOString() });
  pushes.length = 0;
  reqs.length = 0;
  const res = await runEmailAutoImport();
  assert.ok(res, 'the import ran');
  return { id, requests: [...reqs], push: pushes.join('\n'), stillInInbox: inbox.has(id) };
}

// Writes to BG or BFMR (the local sidecar poll nudge and inbox deletes are not group writes).
const writes = (r: readonly Req[]) => r.filter(x => x.write && (x.who === 'bg' || x.who === 'bfmr'));
const outbound = (r: readonly Req[]) => r.filter(x => x.who === 'bg' || x.who === 'bfmr').map(x => `${x.method} ${x.who} ${x.path}${x.body ? ` ${JSON.stringify(x.body)}` : ''}`);

// A BG commitment with a live record on the fake BG and the same state synced locally.
async function commitment(count: number, over: Record<string, unknown> = {}) {
  const n = ++seq;
  const cm = `CM-${n}`;
  const rec = { key: `k${n}`, commitment_id: cm, deal: { key: `deal-${n}`, title: 'Acme Kettle', deal_id: `DL-${n}` }, deal_id: `DL-${n}`, item: { key: `item-${n}`, item_id: `IT-${n}` }, deal_status: true, status: 'ACTIVE', count, fulfilled: 0, expiry_day: '12-31-2026', price: '10', commission: '0', total: String(10 * count), editable: true, ...over };
  bgRecs.set(cm, rec);
  const row = await prisma.buyingGroupCommitment.create({ data: { userId, commitmentId: cm, dealId: rec.deal_id, dealTitle: 'Acme Kettle', count, fulfilled: 0, price: 10, commission: 0, total: 10 * count, status: String(rec.status), raw: JSON.stringify(rec) } });
  return { row, rec };
}

let orderSeq = 0;
async function order(opts: { cost: number; bg?: { c: { id: number }; qty: number }[]; bfmr?: { id: number; qty: number }[]; cancelled?: boolean }) {
  const n = ++orderSeq;
  const number = `2000000-${String(n).padStart(8, '0')}`;
  const o = await prisma.order.create({ data: { userId, platform: 'Walmart', orderNumber: number, orderDate: new Date('2026-11-01'), cost: opts.cost, itemDescription: 'Acme Kettle', cancelled: !!opts.cancelled, locked: false } });
  for (const l of opts.bg ?? []) await prisma.orderCommitmentLink.create({ data: { orderId: o.id, commitmentId: l.c.id, quantity: l.qty } });
  for (const l of opts.bfmr ?? []) await prisma.orderBfmrLink.create({ data: { orderId: o.id, reservationId: l.id, quantity: l.qty } });
  return { o, number };
}

async function reservation(qty: number, retail: number, status = 'reserved') {
  const n = ++seq;
  return prisma.bfmrReservation.create({ data: { userId, reserveId: `RSV-${n}`, lineKey: `RSV-${n}||`, itemName: 'Acme Kettle', dealTitle: 'Acme Kettle deal', status, qty, retailPrice: retail } });
}

async function state(orderId: number) {
  const [o, links, bfl] = await Promise.all([
    prisma.order.findUniqueOrThrow({ where: { id: orderId } }),
    prisma.orderCommitmentLink.findMany({ where: { orderId }, select: { quantity: true, commitmentId: true } }),
    prisma.orderBfmrLink.findMany({ where: { orderId }, select: { quantity: true, reservationId: true } }),
  ]);
  return { cancelled: o.cancelled, locked: o.locked, cost: o.cost, bfmrStatus: o.bfmrStatus, notes: o.notes ?? '', bgLinks: links, bfmrLinks: bfl };
}
const count = async (id: number) => (await prisma.buyingGroupCommitment.findUniqueOrThrow({ where: { id } })).count;

async function mode(on: boolean) { await upsertSetting(userId, CANCEL_REDUCE_KEY, on ? 'true' : 'false'); }
function log(name: string, on: boolean, r: { requests: Req[]; push: string }, st: unknown) {
  if (!process.env.SMOKE_LOG) return;
  console.log(`\n=== ${name} [setting ${on ? 'on' : 'off'}] ===\nrequests:\n  ${outbound(r.requests).join('\n  ') || '(no BG/BFMR call)'}\npush:\n${r.push.replace(/^/gm, '  ')}\nstate: ${JSON.stringify(st)}`);
}

const MODES = [false, true] as const;
const bgEdits = (r: readonly Req[]) => writes(r).filter(x => x.who === 'bg');
const bfmrCancels = (r: readonly Req[]) => writes(r).filter(x => x.who === 'bfmr');

// ---------------------------------------------------------------------------
// 1. Full cancel, one commitment link
// ---------------------------------------------------------------------------
for (const on of MODES) {
  test(`1 full cancel, one BG link (setting ${on ? 'on' : 'off'})`, async () => {
    await mode(on);
    const c = await commitment(5);
    const { o, number } = await order({ cost: 50, bg: [{ c: c.row, qty: 2 }] });
    const r = await deliver({ order: number, item: 'Acme Kettle', qty: 2, amount: 50, whole: true });
    const st = await state(o.id);
    log('full cancel', on, r, st);
    assert.equal(st.cancelled, true);
    assert.equal(st.cost, 0);
    assert.deepEqual(st.bgLinks, [], 'the link is released even with the setting off');
    assert.match(st.notes, /Cancelled order total: \$50\.00/);
    assert.equal(r.stillInInbox, false);
    assert.match(r.push, /cancelled order #\d+ \(was \$50\.00\): marked cancelled\./);
    assert.match(r.push, /Released BuyingGroup: 2× Acme Kettle/);
    if (on) {
      assert.match(r.push, /BG: reduced Acme Kettle 5 → 3/);
      assert.deepEqual(bgEdits(r.requests).map(x => [x.method, x.path, x.body]), [['POST', '/v1/commitment/edit_commitment', { deal_key: c.rec.deal && (c.rec.deal as { key: string }).key, item_key: (c.rec.item as { key: string }).key, quantity: 3 }]]);
      assert.equal(await count(c.row.id), 3);
      assert.equal((await prisma.buyingGroupCommitment.findUniqueOrThrow({ where: { id: c.row.id } })).total, 30);
    } else {
      assert.match(r.push, /BG: would reduce Acme Kettle 5 → 3 \(setting off\)/);
      assert.equal(bgEdits(r.requests).length, 0);
      assert.equal(await count(c.row.id), 5, 'the local commitment count is untouched');
    }
  });
}

// ---------------------------------------------------------------------------
// 2. A commitment shared with other live orders: never below what they hold
// ---------------------------------------------------------------------------
for (const on of MODES) {
  for (const [name, total, released, others, want] of [['others hold 3 of 5, 3 released', 5, 3, 3, 3], ['others hold 4 of 5, 2 released', 5, 2, 4, 4], ['others hold all 5, 2 released', 5, 2, 5, null]] as const) {
    test(`2 shared commitment: ${name} (setting ${on ? 'on' : 'off'})`, async () => {
      await mode(on);
      const c = await commitment(total);
      const other = await order({ cost: 10 * others, bg: [{ c: c.row, qty: others }] });
      const { o, number } = await order({ cost: 10 * released, bg: [{ c: c.row, qty: released }] });
      const r = await deliver({ order: number, item: 'Acme Kettle', qty: released, amount: 10 * released, whole: true });
      assert.deepEqual((await state(other.o.id)).bgLinks, [{ quantity: others, commitmentId: c.row.id }], 'the other order keeps its units');
      assert.deepEqual((await state(o.id)).bgLinks, []);
      log(`shared ${name}`, on, r, null);
      if (want == null) {
        assert.match(r.push, /BG: left Acme Kettle as is \(other orders still hold all of it\)/);
        assert.equal(bgEdits(r.requests).length, 0);
        assert.equal(await count(c.row.id), total);
      } else if (on) {
        assert.match(r.push, new RegExp(`BG: reduced Acme Kettle ${total} → ${want}`));
        assert.deepEqual(bgEdits(r.requests).map(x => (x.body as { quantity: number }).quantity), [want]);
        assert.equal(await count(c.row.id), want);
      } else {
        assert.match(r.push, new RegExp(`BG: would reduce Acme Kettle ${total} → ${want} \\(setting off\\)`));
        assert.equal(bgEdits(r.requests).length, 0);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// 3. Partial cancels: "(x2)" and no "(xN)" (one unit)
// ---------------------------------------------------------------------------
for (const on of MODES) {
  for (const [qty, name] of [[2, '(x2)'], [1, 'no (xN), one unit']] as const) {
    test(`3 partial cancel ${name} (setting ${on ? 'on' : 'off'})`, async () => {
      await mode(on);
      const c = await commitment(6);
      const { o, number } = await order({ cost: 100, bg: [{ c: c.row, qty: 4 }] });
      const r = await deliver({ order: number, item: 'Acme Kettle', qty, amount: 25 * qty });
      const st = await state(o.id);
      log(`partial ${name}`, on, r, st);
      assert.equal(st.cancelled, false);
      assert.equal(st.cost, 100, 'the order cost is left for a person');
      assert.deepEqual(st.bgLinks, [{ quantity: 4 - qty, commitmentId: c.row.id }]);
      assert.match(st.notes, new RegExp(`Partial cancel 2026-11-23: ${qty}× Acme Kettle, \\$${(25 * qty).toFixed(2)} cancelled\\. Order cost not changed: fix it`));
      assert.equal(r.stillInInbox, true, 'the email stays for a person (the cost)');
      assert.match(r.push, new RegExp(`partial cancel on order #${o.id}: ${qty}× Acme Kettle released\\. The order's cost is unchanged: fix it\\.`));
      assert.match(r.push, new RegExp(`Released BuyingGroup: ${qty}× Acme Kettle`));
      // BG 6 → 6 - qty; the order's own 4 - qty remaining units count as held, so never below that.
      const to = Math.max(6 - qty, 4 - qty);
      if (on) {
        assert.match(r.push, new RegExp(`BG: reduced Acme Kettle 6 → ${to}`));
        assert.deepEqual(bgEdits(r.requests).map(x => (x.body as { quantity: number }).quantity), [to]);
        assert.equal(await count(c.row.id), to);
      } else {
        assert.match(r.push, new RegExp(`BG: would reduce Acme Kettle 6 → ${to} \\(setting off\\)`));
        assert.equal(bgEdits(r.requests).length, 0);
        assert.equal(await count(c.row.id), 6);
      }
    });
  }

  test(`3 partial cancel that is not unambiguous changes nothing (setting ${on ? 'on' : 'off'})`, async () => {
    await mode(on);
    const c = await commitment(6);
    const { o, number } = await order({ cost: 100, bg: [{ c: c.row, qty: 2 }] });
    for (const m of [{ item: 'Totally Different Gadget', qty: 1 }, { item: 'Acme Kettle', qty: 3 }]) {
      const r = await deliver({ order: number, item: m.item, qty: m.qty, amount: 25 });
      assert.equal(writes(r.requests).length, 0);
      assert.doesNotMatch(r.push, /Released|BG:|BFMR:/);
      assert.deepEqual((await state(o.id)).bgLinks, [{ quantity: 2, commitmentId: c.row.id }]);
      assert.equal((await state(o.id)).notes, '');
    }
  });
}

// ---------------------------------------------------------------------------
// 4. The same email twice; an email with no date
// ---------------------------------------------------------------------------
for (const on of MODES) {
  test(`4 full cancel delivered twice reduces once (setting ${on ? 'on' : 'off'})`, async () => {
    await mode(on);
    const c = await commitment(5);
    const { o, number } = await order({ cost: 50, bg: [{ c: c.row, qty: 2 }] });
    const mail = { order: number, item: 'Acme Kettle', qty: 2, amount: 50, whole: true };
    await deliver(mail);
    const again = await deliver(mail);
    assert.equal(again.push, '', 'no second notification');
    assert.deepEqual(writes(again.requests), []);
    assert.equal(again.stillInInbox, false);
    assert.equal(await count(c.row.id), on ? 3 : 5);
    assert.equal((await state(o.id)).notes.match(/Cancelled order total/g)?.length, 1);
  });

  test(`4 partial cancel delivered twice is never applied (setting ${on ? 'on' : 'off'})`, async () => {
    await mode(on);
    const c = await commitment(6);
    const { o, number } = await order({ cost: 100, bg: [{ c: c.row, qty: 4 }] });
    const mail = { order: number, item: 'Acme Kettle', qty: 2, amount: 50 };
    await deliver(mail);
    const again = await deliver(mail, nextId());
    assert.doesNotMatch(again.push, /Released|BG:|BFMR:/);
    assert.equal(writes(again.requests).length, 0);
    assert.deepEqual((await state(o.id)).bgLinks, [{ quantity: 2, commitmentId: c.row.id }]);
    assert.equal(await count(c.row.id), on ? 4 : 6);
  });

  test(`4 undated partial cancel re-read on a later day is never applied (setting ${on ? 'on' : 'off'})`, async () => {
    await mode(on);
    const c = await commitment(6);
    const { o, number } = await order({ cost: 100, bg: [{ c: c.row, qty: 4 }] });
    const mail = { order: number, item: 'Acme Kettle', qty: 2, amount: 50, date: null };
    const first = await deliver(mail);
    assert.equal(first.stillInInbox, true);
    // A day later the parser would stamp the email with that day's date: even a note left under another day must not matter.
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const cur = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
    await prisma.order.update({ where: { id: o.id }, data: { notes: (cur.notes ?? '').replace(today, yesterday) } });
    const again = await deliver(mail, nextId());
    log('undated partial, re-read next day', on, again, await state(o.id));
    assert.deepEqual((await state(o.id)).bgLinks, [{ quantity: 4, commitmentId: c.row.id }], 'never cut from a read-time date');
    assert.equal(await count(c.row.id), 6);
  });

  test(`4 undated full cancel works (setting ${on ? 'on' : 'off'})`, async () => {
    await mode(on);
    const c = await commitment(5);
    const { o, number } = await order({ cost: 50, bg: [{ c: c.row, qty: 2 }] });
    const r = await deliver({ order: number, item: 'Acme Kettle', qty: 2, amount: 50, whole: true, date: null });
    assert.equal((await state(o.id)).cancelled, true);
    assert.equal(bgEdits(r.requests).length, on ? 1 : 0);
  });
}

// ---------------------------------------------------------------------------
// 5. BG says no
// ---------------------------------------------------------------------------
const REFUSALS: [string, Record<string, unknown>, RegExp][] = [
  ['deal closed', { deal_status: false }, /the deal is closed on BG/],
  ['expired', { expiry_day: '01-01-2026' }, /the commitment has expired/],
  ['not editable', { editable: false }, /BG does not allow editing it/],
  ['not ACTIVE', { status: 'COMPLETED' }, /commitment is COMPLETED on BG/],
];
for (const on of MODES) {
  for (const [name, over, why] of REFUSALS) {
    test(`5 BG refuses: ${name} (setting ${on ? 'on' : 'off'})`, async () => {
      await mode(on);
      const c = await commitment(5, over);
      const { o, number } = await order({ cost: 50, bg: [{ c: c.row, qty: 2 }] });
      const r = await deliver({ order: number, item: 'Acme Kettle', qty: 2, amount: 50, whole: true });
      log(`BG refuses ${name}`, on, r, null);
      assert.equal((await state(o.id)).cancelled, true, 'the order is still cancelled locally');
      assert.match(r.push, /BG: left Acme Kettle as is \(/);
      assert.match(r.push, why);
      assert.match(r.push, /Check it on BG/);
      assert.equal(bgEdits(r.requests).length, 0);
      assert.equal(await count(c.row.id), 5);
    });
  }

  test(`5 BG edit fails (setting ${on ? 'on' : 'off'})`, async () => {
    await mode(on);
    bg.failEdit = true;
    try {
      const c = await commitment(5);
      const { number } = await order({ cost: 50, bg: [{ c: c.row, qty: 2 }] });
      const r = await deliver({ order: number, item: 'Acme Kettle', qty: 2, amount: 50, whole: true });
      if (on) {
        assert.match(r.push, /BG: could not reduce Acme Kettle \(the BG call failed\)\. Reduce it on BG/);
        assert.equal(bgEdits(r.requests).length, 1);
      } else {
        assert.match(r.push, /would reduce/);
        assert.equal(bgEdits(r.requests).length, 0);
      }
      assert.equal(await count(c.row.id), 5, 'the local count only follows a successful BG edit');
    } finally { bg.failEdit = false; }
  });

  test(`5 BG unreadable: plans from the synced record, never edits (setting ${on ? 'on' : 'off'})`, async () => {
    await mode(on);
    bg.failRead = true;
    try {
      const c = await commitment(5);
      const { number } = await order({ cost: 50, bg: [{ c: c.row, qty: 2 }] });
      const r = await deliver({ order: number, item: 'Acme Kettle', qty: 2, amount: 50, whole: true });
      assert.equal(bgEdits(r.requests).length, 0);
      assert.match(r.push, on ? /BG: left Acme Kettle as is \(BG could not be read just now\)/ : /BG: would reduce Acme Kettle 5 → 3 \(setting off\)/);
    } finally { bg.failRead = false; }
  });
}

// ---------------------------------------------------------------------------
// 6. BFMR-linked orders
// ---------------------------------------------------------------------------
for (const on of MODES) {
  test(`6 BFMR full cancel (setting ${on ? 'on' : 'off'}): BFMR is cancelled either way, as before the setting existed`, async () => {
    await mode(on);
    const rsv = await reservation(2, 50);
    const { o, number } = await order({ cost: 100, bfmr: [{ id: rsv.id, qty: 2 }] });
    const r = await deliver({ order: number, item: 'Acme Kettle', qty: 2, amount: 100, whole: true });
    log('BFMR full cancel', on, r, await state(o.id));
    assert.deepEqual(bfmrCancels(r.requests).map(x => [x.method, x.path, x.body]), [['POST', '/api/v2/my-tracker/reservation/cancel', { reserve_id: [rsv.reserveId] }]]);
    assert.equal((await prisma.bfmrReservation.findUniqueOrThrow({ where: { id: rsv.id } })).status, 'cancelled');
    assert.equal((await state(o.id)).bfmrStatus, 'cancelled');
    assert.deepEqual((await state(o.id)).bfmrLinks, []);
    assert.match(r.push, /Released BFMR: 2× Acme Kettle \(cancelled on BFMR too\)/);
  });

  test(`6 BFMR partial cancel of one whole reservation (setting ${on ? 'on' : 'off'})`, async () => {
    await mode(on);
    const a = await reservation(1, 50);
    const b = await reservation(1, 50);
    const { o, number } = await order({ cost: 100, bfmr: [{ id: a.id, qty: 1 }, { id: b.id, qty: 1 }] });
    // Two lines are the same product: ambiguous, so nothing happens.
    const amb = await deliver({ order: number, item: 'Acme Kettle', qty: 1, amount: 50 });
    assert.equal(writes(amb.requests).length, 0);
    assert.equal((await state(o.id)).bfmrLinks.length, 2);
    // One line only.
    await prisma.orderBfmrLink.delete({ where: { orderId_reservationId_trackingNumber: { orderId: o.id, reservationId: b.id, trackingNumber: null as unknown as string } } }).catch(async () => { await prisma.orderBfmrLink.deleteMany({ where: { orderId: o.id, reservationId: b.id } }); });
    const r = await deliver({ order: number, item: 'Acme Kettle', qty: 1, amount: 50, date: 'Tue, 24 Nov 2026 15:00:00 +0000' });
    log('BFMR partial', on, r, await state(o.id));
    assert.deepEqual((await state(o.id)).bfmrLinks, [], 'the cancelled unit leaves the link');
    assert.equal((await state(o.id)).cancelled, false);
    if (on) {
      assert.deepEqual(bfmrCancels(r.requests).map(x => x.body), [{ reserve_id: [a.reserveId] }]);
      assert.equal((await prisma.bfmrReservation.findUniqueOrThrow({ where: { id: a.id } })).status, 'cancelled');
      assert.match(r.push, /BFMR: cancelled 1 reservation/);
    } else {
      assert.equal(bfmrCancels(r.requests).length, 0);
      assert.equal((await prisma.bfmrReservation.findUniqueOrThrow({ where: { id: a.id } })).status, 'reserved');
      assert.match(r.push, /BFMR: would cancel the reservation \(setting off\)/);
    }
  });

  test(`6 BFMR partial of part of a reservation never reaches BFMR (setting ${on ? 'on' : 'off'})`, async () => {
    await mode(on);
    const rsv = await reservation(2, 50);
    const { o, number } = await order({ cost: 100, bfmr: [{ id: rsv.id, qty: 2 }] });
    const r = await deliver({ order: number, item: 'Acme Kettle', qty: 1, amount: 50 });
    assert.equal(bfmrCancels(r.requests).length, 0);
    assert.deepEqual((await state(o.id)).bfmrLinks, [{ quantity: 1, reservationId: rsv.id }]);
    if (on) assert.match(r.push, /BFMR: left open \(the cancel is 1 of 2 reserved units/);
  });
}

// An email with no Date must never be applied from its read time: the dedupe note would carry a different day on a re-read.
test('undated partial cancel is held for a person and changes nothing', async () => {
  await mode(true);
  const c = await commitment(6);
  const { o, number } = await order({ cost: 100, bg: [{ c: c.row, qty: 4 }] });
  const r = await deliver({ order: number, item: 'Acme Kettle', qty: 2, amount: 50, date: null });
  assert.equal(writes(r.requests).length, 0);
  assert.deepEqual((await state(o.id)).bgLinks, [{ quantity: 4, commitmentId: c.row.id }]);
  assert.equal((await state(o.id)).notes, '');
});
