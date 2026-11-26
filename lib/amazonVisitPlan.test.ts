import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planAmazonVisit, addVisits, pickAuto, pickClick, completeStage, parseState, needsListRead, markListRead, pauseAuto, resumeAuto,
  markRead, settleAutoRun, failBackoffMs, chargeExtraLoads, plannedLoads,
  AUTO_MAX_ORDERS_PER_RUN, AUTO_DAILY_PAGE_LOADS, EMAIL_DELAY_MIN_MS, EMAIL_DELAY_MAX_MS, RECENT_VISIT_MS, CLICK_MAX_ORDERS, emptyState,
  AUTO_MAX_RUNS, AUTO_GIVE_UP_MS, FAIL_BACKOFF_MS, FAIL_QUICK_RETRIES, FAIL_SLOW_RETRY_MS, CLICK_RECENT_READ_MS, LIST_READ_IDLE_CLICK_MS,
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

test('pickAuto: nothing before the delay, a few orders after, no order twice in a row', () => {
  const s = stateWith(8);
  assert.equal(pickAuto(s, later(60_000), mid).visits.length, 0);
  const a = pickAuto(s, later(EMAIL_DELAY_MIN_MS + 1), mid);
  assert.equal(a.visits.length, AUTO_MAX_ORDERS_PER_RUN);
  const b = pickAuto(a.state, later(EMAIL_DELAY_MIN_MS + 2), mid);
  assert.equal(b.visits.length, AUTO_MAX_ORDERS_PER_RUN);
  const seen = new Set([...a.visits, ...b.visits].map(v => v.orderNumber));
  assert.equal(seen.size, 2 * AUTO_MAX_ORDERS_PER_RUN);
});
const FIRST = EMAIL_DELAY_MIN_MS + 1;
test('settle: a run that read nothing puts the order back in line after a short wait', () => {
  const a = pickAuto(stateWith(1), later(FIRST), mid);
  assert.equal(a.visits.length, 1);
  // Not settled yet: the order counts as visited, so nothing for now.
  assert.equal(pickAuto(a.state, later(FIRST + 60_000), mid).visits.length, 0);
  const s1 = settleAutoRun(a.state, [N(1)], later(FIRST), later(FIRST + 120_000));
  assert.equal(s1.entries[0].fails, 1);
  assert.equal(s1.entries[0].lastVisitAt, undefined);
  assert.equal(pickAuto(s1, later(FIRST + 120_000 + FAIL_BACKOFF_MS - 1000), mid).visits.length, 0);
  const b = pickAuto(s1, later(FIRST + 120_000 + FAIL_BACKOFF_MS), mid);
  assert.deepEqual(b.visits.map(v => v.orderNumber), [N(1)]);
  // A second failure waits twice as long.
  const t2 = FIRST + 120_000 + FAIL_BACKOFF_MS;
  const s2 = settleAutoRun(b.state, [N(1)], later(t2), later(t2 + 60_000));
  assert.equal(s2.entries[0].fails, 2);
  assert.equal(pickAuto(s2, later(t2 + 60_000 + FAIL_BACKOFF_MS), mid).visits.length, 0);
  assert.equal(pickAuto(s2, later(t2 + 60_000 + 2 * FAIL_BACKOFF_MS), mid).visits.length, 1);
});
test('settle: after the quick retries one try a day, and never more than the run limit', () => {
  assert.equal(failBackoffMs(1), FAIL_BACKOFF_MS);
  assert.equal(failBackoffMs(FAIL_QUICK_RETRIES), FAIL_QUICK_RETRIES * FAIL_BACKOFF_MS);
  assert.equal(failBackoffMs(FAIL_QUICK_RETRIES + 1), FAIL_SLOW_RETRY_MS);
  let s = stateWith(1);
  let t = FIRST;
  let runs = 0;
  // Ten days of hourly checks, every run reading nothing.
  for (let i = 0; i < 240; i++) {
    const r = pickAuto(s, later(t), mid);
    if (r.visits.length) { runs += 1; s = settleAutoRun(r.state, [N(1)], later(t), later(t + 1000)); } else s = r.state;
    t += 3_600_000;
  }
  assert.equal(runs, AUTO_MAX_RUNS);
});
test('settle: a run that never reached its orders gives them their try back', () => {
  const a = pickAuto(stateWith(1), later(FIRST), mid);
  assert.equal(a.state.entries[0].autoRuns, 1);
  const s = settleAutoRun(a.state, [N(1)], later(FIRST), later(FIRST + 60_000), true);
  assert.equal(s.entries[0].autoRuns, 0);
  assert.equal(s.entries[0].fails ?? 0, 0);
  assert.equal(pickAuto(s, later(FIRST + 60_000 + FAIL_BACKOFF_MS - 1000), mid).visits.length, 0);
  assert.equal(pickAuto(s, later(FIRST + 60_000 + FAIL_BACKOFF_MS), mid).visits.length, 1);
  // Any number of such runs never uses the order's tries up.
  let st = stateWith(1), t = FIRST;
  for (let i = 0; i < 3 * AUTO_MAX_RUNS; i++) {
    const r = pickAuto(st, later(t), mid);
    assert.equal(r.visits.length, 1);
    st = settleAutoRun(r.state, [N(1)], later(t), later(t + 1000), true);
    t += 86_400_000 + FAIL_BACKOFF_MS;   // next day, so the page budget is not what stops it
    st = addVisits(st, [], later(t));
    st.entries[0].queuedAt = later(t).toISOString();
  }
});
test('settle: a page that arrives after its run was settled as unread stops the quick retry', () => {
  const a = pickAuto(stateWith(1, ['detail', 'track']), later(FIRST), mid);
  const settled = settleAutoRun(a.state, [N(1)], later(FIRST), later(FIRST + 31_000));
  const late = markRead(completeStage(settled, N(1), ['detail']), N(1), later(FIRST + 33_000));
  assert.equal(late.entries[0].fails, 0);
  assert.equal(pickAuto(late, later(FIRST + 33_000 + FAIL_BACKOFF_MS), mid).visits.length, 0);
  assert.equal(pickAuto(late, later(FIRST + 33_000 + RECENT_VISIT_MS), mid).visits.length, 1);
});
test('budget: pages a run opened beyond what it was charged come off the day', () => {
  assert.equal(plannedLoads([{ stages: ['detail'] }, { stages: ['detail', 'track'] }, { stages: ['track'] }]), 5);
  const a = pickAuto(stateWith(1, ['detail', 'track']), later(FIRST), mid);
  assert.equal(a.state.auto?.pageLoads, 2);
  const c = chargeExtraLoads(a.state, 2, later(FIRST + 60_000));
  assert.equal(c.auto?.pageLoads, 4);
  assert.equal(chargeExtraLoads(c, 0, later(FIRST)), c);
  assert.equal(chargeExtraLoads(c, -3, later(FIRST)), c);
  // The next day starts from zero.
  assert.equal(chargeExtraLoads(c, 1, later(FIRST + 86_400_000)).auto?.pageLoads, 1);
});
test('addVisits: a new email for an order forgets the earlier read', () => {
  const read = markRead(stateWith(1, ['detail']), N(1), later(1000));
  // Read with only details left (compare mode): no automatic visit.
  assert.equal(pickAuto(read, later(FIRST + RECENT_VISIT_MS), mid).visits.length, 0);
  const again = addVisits(read, [{ order: N(1), stages: ['track'] }], later(FIRST + RECENT_VISIT_MS));
  assert.equal(again.entries[0].lastReadAt, undefined);
});
test('settle: an order whose page was read since the run was queued is left alone', () => {
  const a = pickAuto(stateWith(2, ['detail', 'track']), later(FIRST), mid);
  const read = markRead(completeStage(a.state, N(1), ['detail']), N(1), later(FIRST + 30_000));
  const s = settleAutoRun(read, [N(1), N(2)], later(FIRST), later(FIRST + 60_000));
  const e1 = s.entries.find(e => e.order === N(1))!, e2 = s.entries.find(e => e.order === N(2))!;
  assert.equal(e1.fails, 0);
  assert.equal(e1.lastVisitAt, later(FIRST + 30_000).toISOString());
  assert.equal(e2.fails, 1);
  // Nothing to settle gives the same state back.
  assert.equal(settleAutoRun(s, [N(3)], later(FIRST), later(FIRST + 60_000)), s);
});
test('pickAuto: read but still no tracking gets another look every 6 hours, up to the run limit', () => {
  let s = stateWith(1, ['detail', 'track']);
  let t = FIRST;
  let runs = 0;
  for (let i = 0; i < AUTO_MAX_RUNS + 3; i++) {
    const r = pickAuto(s, later(t), mid);
    if (!r.visits.length) break;
    runs += 1;
    if (runs > 1) assert.deepEqual(r.visits[0].stages, ['track']);
    s = markRead(completeStage(r.state, N(1), ['detail']), N(1), later(t + 30_000));
    assert.equal(pickAuto(s, later(t + RECENT_VISIT_MS - 60_000), mid).visits.length, 0);
    t += RECENT_VISIT_MS + 24 * 3_600_000; // a new day each time, so the daily budget is not what stops it
    s = { ...s, entries: s.entries.map(e => ({ ...e, queuedAt: later(t).toISOString() })) }; // nor the give-up age
  }
  assert.equal(runs, AUTO_MAX_RUNS);
});
test('pickAuto: a read order with only details left (compare mode) is not visited again', () => {
  const a = pickAuto(stateWith(1), later(FIRST), mid);
  const s = markRead(a.state, N(1), later(FIRST + 30_000));
  assert.equal(pickAuto(s, later(FIRST + RECENT_VISIT_MS + 60_000), mid).visits.length, 0);
});
test('pickAuto: gives up a week after the last email; a new email starts over', () => {
  const s = stateWith(1, ['detail']);
  assert.equal(pickAuto(s, later(AUTO_GIVE_UP_MS + 60_000), mid).visits.length, 0);
  const done = completeStage(markRead(pickAuto(s, later(FIRST), mid).state, N(1), later(FIRST)), N(1), ['detail']);
  const again = addVisits(done, [{ order: N(1), stages: ['track'] }], later(AUTO_GIVE_UP_MS + 60_000), () => 0);
  assert.equal(again.entries[0].autoRuns, 0);
  const r = pickAuto(again, later(AUTO_GIVE_UP_MS + 60_000 + EMAIL_DELAY_MIN_MS), mid);
  assert.deepEqual(r.visits.map(v => v.stages), [['track']]);
});
test('pickAuto: orders saved by the earlier version (tried once, never read) are tried again', () => {
  const old: VisitState = { entries: [
    { order: N(1), stages: ['detail', 'track'], done: [], autoTried: ['detail', 'track'], queuedAt: T0.toISOString(), dueAt: T0.toISOString(), lastVisitAt: T0.toISOString() },
    { order: N(2), stages: ['detail'], done: [], autoTried: ['detail'], queuedAt: T0.toISOString(), dueAt: T0.toISOString(), lastVisitAt: T0.toISOString() },
    { order: N(3), stages: ['detail'], done: [], autoTried: [], queuedAt: T0.toISOString(), dueAt: later(RECENT_VISIT_MS + 1).toISOString() },
  ] };
  assert.equal(pickAuto(old, later(RECENT_VISIT_MS - 1), mid).visits.length, 0);
  const r = pickAuto(old, later(RECENT_VISIT_MS + 1), mid);
  assert.equal(r.visits.length, 3);
  // The never-tried order is first in line (before the shuffle): it has the fewest runs.
  assert.deepEqual(r.state.entries.map(e => e.autoRuns), [2, 2, 1]);
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

test('pickClick: a capped random subset, ignores the email delay, untried orders first', () => {
  const s = stateWith(15);
  const a = pickClick(s, T0, CLICK_MAX_ORDERS, mid);
  assert.equal(a.visits.length, CLICK_MAX_ORDERS);
  // Nothing was read: a second click takes the 5 not yet tried, then tries 5 of the others again.
  const b = pickClick(a.state, later(1000), CLICK_MAX_ORDERS, mid);
  assert.equal(b.visits.length, CLICK_MAX_ORDERS);
  const first = new Set(a.visits.map(v => v.orderNumber));
  assert.deepEqual(b.visits.slice(0, 5).filter(v => first.has(v.orderNumber)), []);
});
test('pickClick: an order read in the last half hour is left out; a recent visit that read nothing is not', () => {
  const a = pickClick(stateWith(3), T0, CLICK_MAX_ORDERS, mid);
  const s = markRead(a.state, N(1), later(1000));
  assert.deepEqual(pickClick(s, later(2000), CLICK_MAX_ORDERS, mid).visits.map(v => v.orderNumber).sort(), [N(2), N(3)]);
  assert.equal(pickClick(s, later(1000 + CLICK_RECENT_READ_MS), CLICK_MAX_ORDERS, mid).visits.length, 3);
  // An automatic run that read nothing does not hide its orders from a click.
  const auto = pickAuto(stateWith(3), later(EMAIL_DELAY_MIN_MS + 1), mid);
  assert.equal(pickClick(auto.state, later(EMAIL_DELAY_MIN_MS + 5000), CLICK_MAX_ORDERS, mid).visits.length, 3);
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
  // A click with no order to visit asks with the shorter limit.
  assert.equal(needsListRead(s, later(LIST_READ_IDLE_CLICK_MS - 1000), LIST_READ_IDLE_CLICK_MS), false);
  assert.equal(needsListRead(s, later(LIST_READ_IDLE_CLICK_MS), LIST_READ_IDLE_CLICK_MS), true);
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
