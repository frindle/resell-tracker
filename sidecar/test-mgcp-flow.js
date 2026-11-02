'use strict';
const assert = require('assert');
const { runMgcpCapture, parseTitle, parseCardNumber, parsePin } = require('./src/mgcpFlow');

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

  // 7. secrets never reach logs
  const all = logs.join('\n');
  assert(!all.includes(SECRET_NUM) && !all.includes(SECRET_PIN) && !/SECRET\d/.test(all), 'secrets leaked into logs');

  console.log('test-mgcp-flow: ok');
})().catch(e => { console.error(e); process.exit(1); });
