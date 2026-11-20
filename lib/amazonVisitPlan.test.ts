import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planAmazonVisit, addVisits, pickAuto, pickClick, completeStage, parseState, needsListRead, markListRead, pauseAuto, resumeAuto,
  AUTO_MAX_ORDERS_PER_RUN, AUTO_DAILY_PAGE_LOADS, EMAIL_DELAY_MIN_MS, EMAIL_DELAY_MAX_MS, RECENT_VISIT_MS, CLICK_MAX_ORDERS, emptyState,
  type VisitRow, type VisitState,
} from './amazonVisitPlan.ts';
import { safeAmazonOrderLink } from './amazonOrderLink.ts';
import { amazonOrderLink } from './emailParse.ts';

const full: VisitRow = { cardId: 1, shippingAddress: 'Pat Example, 1 Main St, Springfield, ST 00000', cost: 10, itemDescription: 'Thing', trackingNumbers: null, cancelled: false };
const T0 = new Date('2026-01-10T12:00:00Z');
const N = (i: number) => `111-0000000-${String(i).padStart(7, '0')}`;
const mid = () => 0.5;

test('plan: ordered email with everything present queues nothing', () => {
  assert.deepEqual(planAmazonVisit('ordered', full).stages, []);
});
test('plan: missing card/address/cost/item queues the detail page only', () => {
  assert.deepEqual(planAmazonVisit('ordered', { ...full, cardId: null }).stages, ['detail']);
  assert.deepEqual(planAmazonVisit('ordered', { ...full, shippingAddress: '' }).reasons, ['address']);
  assert.deepEqual(planAmazonVisit('ordered', { ...full, cost: 0 }).reasons, ['cost']);
  assert.deepEqual(planAmazonVisit('ordered', { ...full, itemDescription: 'amazon.com' }).reasons, ['item']);
});
test('plan: a shipped email with no tracking queues detail + track', () => {
  assert.deepEqual(planAmazonVisit('shipped', full).stages, ['detail', 'track']);
  assert.deepEqual(planAmazonVisit('shipped', { ...full, trackingNumbers: '1Z999' }).stages, []);
});
test('plan: an ORDER email never asks for tracking', () => {
  assert.deepEqual(planAmazonVisit('ordered', { ...full, trackingNumbers: null }).stages, []);
});
test('plan: delivered and cancelled emails and orders need no visit', () => {
  assert.deepEqual(planAmazonVisit('delivered', { ...full, cardId: null }).stages, []);
  assert.deepEqual(planAmazonVisit('cancelled', { ...full, cardId: null }).stages, []);
  assert.deepEqual(planAmazonVisit('shipped', { ...full, cancelled: true }).stages, []);
  assert.deepEqual(planAmazonVisit('shipped', { ...full, delivered: true }).stages, []);
});
test('plan: the judge hook can override; null keeps the rule', () => {
  assert.deepEqual(planAmazonVisit('shipped', full, () => ({ stages: ['detail'], reasons: ['x'] })).stages, ['detail']);
  assert.deepEqual(planAmazonVisit('shipped', full, () => null).stages, ['detail', 'track']);
});

test('addVisits: random delay of 5 to 25 minutes, no repeat of a pending or finished stage', () => {
  let s = addVisits(emptyState(), [{ order: N(1), stages: ['detail'] }], T0, () => 0);
  assert.equal(new Date(s.entries[0].dueAt).getTime() - T0.getTime(), EMAIL_DELAY_MIN_MS);
  s = addVisits(emptyState(), [{ order: N(1), stages: ['detail'] }], T0, () => 1);
  assert.equal(new Date(s.entries[0].dueAt).getTime() - T0.getTime(), EMAIL_DELAY_MAX_MS);
  s = addVisits(s, [{ order: N(1), stages: ['detail'] }], T0, mid);
  assert.equal(s.entries.length, 1); assert.deepEqual(s.entries[0].stages, ['detail']);
  s = completeStage(s, N(1), ['detail']);
  s = addVisits(s, [{ order: N(1), stages: ['detail'] }], T0, mid);
  assert.deepEqual(s.entries[0].stages, []);
  s = addVisits(s, [{ order: N(1), stages: ['detail', 'track'] }], T0, mid);
  assert.deepEqual(s.entries[0].stages, ['track']);
});
test('addVisits: bad order numbers are ignored; first stored link kept', () => {
  const s = addVisits(emptyState(), [{ order: 'nope', stages: ['detail'] }, { order: N(2), url: 'https://www.amazon.com/x', stages: ['detail'] }], T0, mid);
  assert.equal(s.entries.length, 1);
  const s2 = addVisits(s, [{ order: N(2), url: 'https://www.amazon.com/y', stages: ['track'] }], T0, mid);
  assert.equal(s2.entries[0].url, 'https://www.amazon.com/x');
});

const later = (ms: number) => new Date(T0.getTime() + ms);
function stateWith(n: number, stages: ('detail' | 'track')[] = ['detail']): VisitState {
  return addVisits(emptyState(), Array.from({ length: n }, (_, i) => ({ order: N(i + 1), stages })), T0, () => 0);
}

test('pickAuto: nothing before the delay, a few orders after, each stage once', () => {
  const s = stateWith(8);
  assert.equal(pickAuto(s, later(60_000), mid).visits.length, 0);
  const a = pickAuto(s, later(EMAIL_DELAY_MIN_MS + 1), mid);
  assert.equal(a.visits.length, AUTO_MAX_ORDERS_PER_RUN);
  const b = pickAuto(a.state, later(EMAIL_DELAY_MIN_MS + 2), mid);
  assert.equal(b.visits.length, AUTO_MAX_ORDERS_PER_RUN);
  const seen = new Set([...a.visits, ...b.visits].map(v => v.orderNumber));
  assert.equal(seen.size, 2 * AUTO_MAX_ORDERS_PER_RUN);
});
test('pickAuto: an automatically tried stage is never auto-visited again', () => {
  const s = stateWith(1);
  const a = pickAuto(s, later(EMAIL_DELAY_MIN_MS + 1), mid);
  assert.equal(a.visits.length, 1);
  assert.equal(pickAuto(a.state, later(RECENT_VISIT_MS + EMAIL_DELAY_MIN_MS), mid).visits.length, 0);
});
test('pickAuto: daily page budget, resets next day', () => {
  let s = stateWith(40, ['detail', 'track']);
  let total = 0;
  let t = EMAIL_DELAY_MIN_MS + 1;
  for (let i = 0; i < 20; i++) { const r = pickAuto(s, later(t), mid); s = r.state; total += r.visits.length * 2; t += 1000; }
  assert.equal(total, AUTO_DAILY_PAGE_LOADS);
  const next = pickAuto(s, later(24 * 3_600_000 + EMAIL_DELAY_MIN_MS), mid);
  assert.ok(next.visits.length > 0);
});
test('pickAuto: paused until resumed', () => {
  const s = pauseAuto(stateWith(2), T0);
  assert.equal(pickAuto(s, later(EMAIL_DELAY_MAX_MS + 1), mid).visits.length, 0);
  assert.equal(pickAuto(resumeAuto(s), later(EMAIL_DELAY_MAX_MS + 1), mid).visits.length, 2);
});

test('pickClick: a capped random subset, recent visits skipped, ignores the email delay', () => {
  const s = stateWith(15);
  const a = pickClick(s, T0, CLICK_MAX_ORDERS, mid);
  assert.equal(a.visits.length, CLICK_MAX_ORDERS);
  const b = pickClick(a.state, later(1000), CLICK_MAX_ORDERS, mid);
  assert.equal(b.visits.length, 5);
  const c = pickClick(b.state, later(RECENT_VISIT_MS + 5000), CLICK_MAX_ORDERS, mid);
  assert.equal(c.visits.length, CLICK_MAX_ORDERS);
});
test('pickClick: finished orders are not offered', () => {
  const s = completeStage(stateWith(1), N(1), ['detail']);
  assert.equal(pickClick(s, T0, 10, mid).visits.length, 0);
});

test('list read: due once a day', () => {
  assert.equal(needsListRead(emptyState(), T0), true);
  const s = markListRead(emptyState(), T0);
  assert.equal(needsListRead(s, later(23 * 3_600_000)), false);
  assert.equal(needsListRead(s, later(24 * 3_600_000)), true);
});
test('parseState: junk gives an empty state', () => {
  assert.deepEqual(parseState('not json').entries, []);
  assert.deepEqual(parseState(null).entries, []);
});

test('safeAmazonOrderLink: https amazon.com order-details only, host normalised', () => {
  const ok = 'https://www.amazon.com/gp/your-account/order-details?ie=UTF8&orderID=111-0000000-0000001';
  assert.equal(safeAmazonOrderLink(ok), 'https://www.amazon.com/gp/your-account/order-details?orderID=111-0000000-0000001');
  assert.equal(safeAmazonOrderLink('https://smile.amazon.com/your-orders/order-details?orderID=111-0000000-0000001'), 'https://www.amazon.com/your-orders/order-details?orderID=111-0000000-0000001');
  for (const bad of [
    'http://www.amazon.com/gp/your-account/order-details?orderID=111-0000000-0000001',
    'https://www.amazon.com.evil.example/gp/your-account/order-details?orderID=111-0000000-0000001',
    'https://evil.example/gp/your-account/order-details?orderID=111-0000000-0000001&x=amazon.com',
    'https://notamazon.com/gp/your-account/order-details?orderID=111-0000000-0000001',
    'https://user:pw@www.amazon.com/gp/your-account/order-details?orderID=111-0000000-0000001',
    'https://www.amazon.com/gp/r.html?U=https://x&orderID=111-0000000-0000001',
    'https://www.amazon.com/gp/your-account/order-details?orderID=abc',
    'javascript:alert(1)', '', null,
  ]) assert.equal(safeAmazonOrderLink(bad), null, String(bad));
});
test('amazonOrderLink: only the email\'s own order, only a safe link', () => {
  const body = 'View: https://www.amazon.com/gp/your-account/order-details?orderID=111-0000000-0000001&ref=x\nother https://evil.example/order-details?orderID=111-0000000-0000001';
  assert.match(amazonOrderLink(body, '111-0000000-0000001'), /^https:\/\/www\.amazon\.com\/gp\/your-account\/order-details\?orderID=/);
  assert.equal(amazonOrderLink(body, '111-0000000-0000002'), '');
  assert.equal(amazonOrderLink('https://evil.example/order-details?orderID=111-0000000-0000001', '111-0000000-0000001'), '');
});
