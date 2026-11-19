'use strict';
const assert = require('assert');
const { runMgcpCapture, parseTitle, parseCardNumber, parsePin, makePlaywrightDriver, hintsFor } = require('./src/mgcpFlow');

const SECRET_NUM = '6006490000000000999';
const SECRET_PIN = '4321';
const logs = [];
const log = m => logs.push(m);

function fakeDriver(script) {
  const calls = [];
  let tick = 0;
  return {
    calls,
    async open(l) { calls.push('open'); return { title: script.title === undefined ? 'Total Wine & More - $100 Gift Card' : script.title }; },
    async state() { return script.states[Math.min(tick++, script.states.length - 1)]; },
    async clickUse() { calls.push('click'); },
    async readCard() { return { cardNumber: 'Gift Card Number: ' + SECRET_NUM.replace(/(.{4})/g, '$1 '), pin: 'PIN: ' + SECRET_PIN }; },
    async capturePdf() { return Buffer.from('pdf'); },
    async captureBarcode() { return Buffer.from('png'); },
    async closeTab() { calls.push('close'); },
  };
}
const mk = (id) => ({ id, link: 'https://www.mygiftcardsplus.com/card?c=SECRET' + id });

(async () => {
  assert.deepStrictEqual(parseTitle('Total Wine & More - $100 Gift Card'), { merchant: 'Total Wine & More', value: 100 });
  assert.deepStrictEqual(parseTitle('Best Buy - $1,250.50 eGift Card'), { merchant: 'Best Buy', value: 1250.5 });
  assert.strictEqual(parseTitle('Gift Card Pickup'), null);
  assert.strictEqual(parseCardNumber('Gift Card Number: 1234 5678'), '12345678');
  assert.strictEqual(parsePin('PIN: 12 34'), '1234');
  assert.strictEqual(parsePin(''), null);

  // 1. happy path with landing click, no captcha
  let saved = [];
  let d = fakeDriver({ states: ['landing', 'card'] });
  let r = await runMgcpCapture({ driver: d, links: [mk(1), mk(2)], save: async c => saved.push(c), sleep: async () => {}, log, delayMs: 0 });
  assert.deepStrictEqual([r.saved, r.failed, r.stopped], [2, 0, null]);
  assert.strictEqual(saved[0].cardNumber, SECRET_NUM);
  assert.strictEqual(saved[0].pin, SECRET_PIN);
  assert.strictEqual(saved[0].merchant, 'Total Wine & More');
  assert.strictEqual(saved[0].value, 100);
  assert(d.calls.includes('click'));

  // 2. captcha appears, human clears it, run resumes; onCaptcha true then false
  const cap = [];
  saved = [];
  let t = 0;
  d = fakeDriver({ states: ['landing', 'captcha', 'captcha', 'captcha', 'card'] });
  r = await runMgcpCapture({ driver: d, links: [mk(1)], save: async c => saved.push(c), onCaptcha: async v => cap.push(v), sleep: async () => { t += 1000; }, now: () => t, log });
  assert.strictEqual(r.saved, 1);
  assert.deepStrictEqual(cap, [true, false]);

  // 3. captcha never cleared -> stops the whole run, remaining links untouched
  const failed = [];
  t = 0; cap.length = 0; saved = [];
  d = fakeDriver({ states: ['captcha'] });
  r = await runMgcpCapture({ driver: d, links: [mk(1), mk(2)], save: async c => saved.push(c), markFailed: async (i, why) => failed.push([i, why]), onCaptcha: async v => cap.push(v), sleep: async () => { t += 60000; }, now: () => t, captchaTimeoutMs: 120000, log });
  assert.strictEqual(r.stopped, 'captcha-timeout');
  assert.strictEqual(saved.length, 0);
  assert.strictEqual(failed.length, 0, 'timed-out link stays pending, not failed');
  assert.deepStrictEqual(cap, [true, false]);
  assert.strictEqual(d.calls.filter(c => c === 'open').length, 1, 'did not move on to link 2');

  // 4. a bad link fails and the run continues with the next one
  failed.length = 0; saved = [];
  let n = 0;
  const flaky = fakeDriver({ states: ['card'] });
  flaky.readCard = async () => (++n === 1 ? { cardNumber: '', pin: '' } : { cardNumber: SECRET_NUM, pin: '' });
  r = await runMgcpCapture({ driver: flaky, links: [mk(1), mk(2)], save: async c => saved.push(c), markFailed: async (i, why) => failed.push([i, why]), sleep: async () => {}, log, delayMs: 0 });
  assert.deepStrictEqual([r.saved, r.failed], [1, 1]);
  assert.deepStrictEqual(failed, [[1, 'no-card-number']]);
  assert.strictEqual(saved[0].pin, null);

  // 5. unparseable title fails that link, never saves
  failed.length = 0; saved = [];
  r = await runMgcpCapture({ driver: fakeDriver({ title: 'Gift Card Pickup', states: ['card'] }), links: [mk(1)], save: async c => saved.push(c), markFailed: async (i, why) => failed.push([i, why]), sleep: async () => {}, log });
  assert.deepStrictEqual(failed, [[1, 'title-unparsed']]);
  assert.strictEqual(saved.length, 0);

  // 6. stuck on landing / unknown -> card-not-ready
  failed.length = 0; t = 0;
  r = await runMgcpCapture({ driver: fakeDriver({ states: ['unknown'] }), links: [mk(1)], save: async () => {}, markFailed: async (i, why) => failed.push([i, why]), sleep: async () => { t += 10000; }, now: () => t, readyTimeoutMs: 30000, log });
  assert.deepStrictEqual(failed, [[1, 'card-not-ready']]);

  // 6b. the stuck reason says where it stopped: last state, clicks, tab hosts
  // and hint words, and nothing from the link or the page text.
  failed.length = 0; t = 0; logs.length = 0;
  d = fakeDriver({ states: ['unknown'] });
  d.describe = async () => [
    { host: 'pickup.example.test', hints: ['card-words'] },
    { host: 'cards.example.test?c=SECRET9', hints: ['made-up', 'verify'] },
    { host: '', hints: [] },
  ];
  r = await runMgcpCapture({ driver: d, links: [mk(1)], save: async () => {}, markFailed: async (i, why) => failed.push([i, why]), sleep: async () => { t += 10000; }, now: () => t, readyTimeoutMs: 30000, log });
  assert.deepStrictEqual(failed, [[1, 'card-not-ready']], 'stored status reason stays the plain code');
  assert.deepStrictEqual(r.failures, ['card-not-ready; last=unknown clicks=0 tabs=pickup.example.test(card-words) other(verify) blank']);
  assert(logs.some(l => l.includes('failed (card-not-ready; last=unknown clicks=0 tabs=pickup.example.test(card-words) other(verify) blank)')), logs.join('\n'));

  // 6c. a landing page that ignores the click: re-clicks a few times, spaced
  // out, then gives up on the ready timeout instead of looping forever.
  failed.length = 0; t = 0;
  d = fakeDriver({ states: ['landing'] });
  r = await runMgcpCapture({ driver: d, links: [mk(1)], save: async () => {}, markFailed: async (i, why) => failed.push([i, why]), sleep: async () => { t += 1000; }, now: () => t, readyTimeoutMs: 45000, reclickMs: 8000, maxClicks: 3, log });
  assert.deepStrictEqual(failed, [[1, 'card-not-ready']]);
  assert.strictEqual(d.calls.filter(c => c === 'click').length, 3, 'capped at maxClicks');
  assert(/last=landing clicks=3/.test(r.failures[0]), r.failures[0]);
  assert(t <= 47000, `gave up near the ready timeout, not later (t=${t})`);

  // 6d. a click that takes: landing, then loading, then the card; one click.
  saved = []; t = 0;
  d = fakeDriver({ states: ['landing', 'unknown', 'unknown', 'card'] });
  r = await runMgcpCapture({ driver: d, links: [mk(1)], save: async c => saved.push(c), sleep: async () => { t += 1000; }, now: () => t, log });
  assert.strictEqual(r.saved, 1);
  assert.strictEqual(d.calls.filter(c => c === 'click').length, 1);

  // 6e. a driver error (Playwright quotes the URL in its message) logs the
  // step and the error class only.
  failed.length = 0; logs.length = 0;
  d = fakeDriver({ states: ['card'] });
  d.open = async (l) => { const e = new Error(`page.goto: Timeout 45000ms exceeded navigating to "${l}"`); e.name = 'TimeoutError'; throw e; };
  r = await runMgcpCapture({ driver: d, links: [mk(1)], save: async () => {}, markFailed: async (i, why) => failed.push([i, why]), sleep: async () => {}, log });
  assert.deepStrictEqual(failed, [[1, 'driver-error']]);
  assert.deepStrictEqual(r.failures, ['driver-error; step=open err=TimeoutError']);

  // hint words
  assert.deepStrictEqual(hintsFor('Enter the security code we sent'), ['verify']);
  assert.deepStrictEqual(hintsFor('This card has already been redeemed'), ['expired']);
  assert.deepStrictEqual(hintsFor('Request unsuccessful.'), ['blocked']);
  assert.deepStrictEqual(hintsFor('Gift Card Number 1234 PIN 99'), ['card-words']);
  assert.deepStrictEqual(hintsFor(''), []);

  // 7. secrets never reach logs
  const all = logs.join('\n');
  assert(!all.includes(SECRET_NUM) && !all.includes(SECRET_PIN) && !/SECRET\d/.test(all), 'secrets leaked into logs');

  // 8. the Playwright driver follows the most advanced open tab, so a card
  // that opened in an older tab (or behind a newer blank popup) is found.
  const fakePage = (kind, url) => {
    let closed = false;
    const has = { card: kind === 'card', captcha: kind === 'captcha', landing: kind === 'landing' };
    return {
      kind,
      isClosed: () => closed,
      close: async () => { closed = true; },
      url: () => url,
      locator: (sel) => ({
        count: async () => (sel === '.gift-card-number > div' ? (has.card ? 1 : 0) : sel === 'iframe#main-iframe' ? (has.captcha ? 1 : 0) : 0),
        innerText: async () => (sel === 'body' ? (kind === 'card' ? 'Gift Card Number' : '') : ''),
        first() { return this; },
      }),
      getByText: () => ({ count: async () => (has.landing ? 1 : 0), first() { return this; } }),
    };
  };
  const ctxWith = (pages) => ({ pages: () => pages });
  let drv = makePlaywrightDriver(ctxWith([fakePage('landing', 'https://pickup.example.test/x?c=SECRET1'), fakePage('card', 'https://cards.example.test/c/SECRET2'), fakePage('unknown', 'about:blank')]));
  assert.strictEqual(await drv.state(), 'card');
  drv = makePlaywrightDriver(ctxWith([fakePage('landing', 'https://pickup.example.test/x?c=SECRET1'), fakePage('unknown', 'about:blank')]));
  assert.strictEqual(await drv.state(), 'landing');
  drv = makePlaywrightDriver(ctxWith([fakePage('captcha', 'https://cards.example.test/'), fakePage('landing', 'https://pickup.example.test/')]));
  assert.strictEqual(await drv.state(), 'captcha');
  drv = makePlaywrightDriver(ctxWith([]));
  assert.strictEqual(await drv.state(), 'unknown');
  const desc = await makePlaywrightDriver(ctxWith([fakePage('landing', 'https://pickup.example.test/x?c=SECRET1'), fakePage('card', 'https://cards.example.test/c/SECRET2'), fakePage('unknown', 'about:blank')])).describe();
  assert.deepStrictEqual(desc, [{ host: 'pickup.example.test', hints: [] }, { host: 'cards.example.test', hints: ['card-words'] }, { host: '', hints: [] }]);
  assert(!JSON.stringify(desc).includes('SECRET'), 'no path or query in describe()');

  console.log('test-mgcp-flow: ok');
})().catch(e => { console.error(e); process.exit(1); });
