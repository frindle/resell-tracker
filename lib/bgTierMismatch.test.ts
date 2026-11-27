import test from 'node:test';
import assert from 'node:assert/strict';
import { bgPayoutTiers } from './bgPayoutTiers.ts';
import { tierMismatch, carrierScanLine, lastDelivery } from './bgTierMismatch.ts';

// Synthetic tiered deal: Priority ($11) by the end of Dec 4 Pacific, Base ($2) by the end of Dec 28 Pacific.
const tier = (label: string, commission: string, deliverBy: string, extra: Record<string, unknown> = {}) => ({
  label, deliver_by: deliverBy, price: '100.00', commission, is_base: label === 'Base', is_bg_label: false, ...extra,
});
const SPEED = bgPayoutTiers(JSON.stringify({ payout_tiers: [
  tier('Base', '2.00', '12-29-2026 07:59:59'),
  tier('Priority', '11.00', '12-05-2026 07:59:59'),
] }));
const LABEL = bgPayoutTiers(JSON.stringify({ payout_tiers: [
  tier('Base', '5.00', '12-29-2026 07:59:59'),
  tier('10+ BG Label', '3.00', '12-29-2026 07:59:59'),
] }));
const at = (s: string) => new Date(s);

test('delivered in time, BG scanned late, paid Base', () => {
  const m = tierMismatch({ tiers: SPEED, deliveredAt: at('2026-12-04T22:30:00Z'), scannedAt: at('2026-12-06T18:00:00Z'), paidCommission: 2 });
  assert.equal(m.shouldHave?.label, 'Priority');
  assert.equal(m.paid?.label, 'Base');
  assert.equal(m.late, true);
  assert.equal(m.shortfall, 9);
});

test('the delivery day decides, whatever the hour shown', () => {
  // 23:50 on Dec 4 is still Dec 4; 00:10 on Dec 5 is Dec 5.
  assert.equal(tierMismatch({ tiers: SPEED, deliveredAt: at('2026-12-04T23:50:00Z'), scannedAt: at('2026-12-07T00:00:00Z'), paidCommission: 2 }).shouldHave?.label, 'Priority');
  assert.equal(tierMismatch({ tiers: SPEED, deliveredAt: at('2026-12-05T00:10:00Z'), scannedAt: at('2026-12-07T00:00:00Z'), paidCommission: 2 }).shouldHave?.label, 'Base');
});

test('23:30 local on the deadline day is on time; the next minute of the next day is not', () => {
  const scanned = at('2026-12-07T00:00:00Z');
  assert.equal(tierMismatch({ tiers: SPEED, deliveredAt: at('2026-12-04T23:30:00Z'), scannedAt: scanned, paidCommission: 2 }).shouldHave?.label, 'Priority');
  assert.equal(tierMismatch({ tiers: SPEED, deliveredAt: at('2026-12-05T00:00:00Z'), scannedAt: scanned, paidCommission: 2 }).shouldHave?.label, 'Base');
  // Same for the last tier's deadline (end of Dec 28 Pacific).
  assert.equal(tierMismatch({ tiers: SPEED, deliveredAt: at('2026-12-28T23:30:00Z'), scannedAt: scanned, paidCommission: 2 }).shouldHave?.label, 'Base');
  assert.equal(tierMismatch({ tiers: SPEED, deliveredAt: at('2026-12-29T00:30:00Z'), scannedAt: scanned, paidCommission: 2 }).shouldHave, null);
});

test('lastDelivery needs every number of every order delivered', () => {
  const dates: Record<string, Date> = { A: at('2026-12-02T12:00:00Z'), B: at('2026-12-04T12:00:00Z') };
  const get = (n: string) => dates[n];
  assert.equal(lastDelivery([['A'], ['B']], get)?.toISOString(), '2026-12-04T12:00:00.000Z');
  assert.equal(lastDelivery([['A', 'B']], get)?.toISOString(), '2026-12-04T12:00:00.000Z');
  assert.equal(lastDelivery([['A'], ['C']], get), null);
  assert.equal(lastDelivery([['A'], []], get), null);
  assert.equal(lastDelivery([], get), null);
});

test('the scan day in the line is its Pacific day', () => {
  // 03:00 UTC on Dec 7 is the evening of Dec 6 in Pacific time.
  assert.equal(carrierScanLine(at('2026-12-04T12:00:00Z'), at('2026-12-07T03:00:00Z')), 'Carrier delivered 2026-12-04; BG scanned 2026-12-06');
});

test('scanned in time and paid right is no mismatch', () => {
  const m = tierMismatch({ tiers: SPEED, deliveredAt: at('2026-12-02T12:00:00Z'), scannedAt: at('2026-12-03T12:00:00Z'), paidCommission: 11 });
  assert.equal(m.shouldHave?.label, 'Priority');
  assert.equal(m.paid?.label, 'Priority');
  assert.equal(m.late, false);
  assert.equal(m.shortfall, 0);
});

test('a delivery that missed every deadline earns nothing', () => {
  const m = tierMismatch({ tiers: SPEED, deliveredAt: at('2026-12-30T12:00:00Z'), scannedAt: at('2026-12-31T12:00:00Z'), paidCommission: 2 });
  assert.equal(m.shouldHave, null);
  assert.equal(m.late, false);
  assert.equal(m.shortfall, 0);
});

test('a commission matching no tier has no paid tier but still shows the shortfall', () => {
  const m = tierMismatch({ tiers: SPEED, deliveredAt: at('2026-12-02T12:00:00Z'), scannedAt: at('2026-12-06T12:00:00Z'), paidCommission: 4.5 });
  assert.equal(m.paid, null);
  assert.equal(m.shortfall, 6.5);
});

test('a BG-label commission is never called short', () => {
  const m = tierMismatch({ tiers: LABEL, deliveredAt: at('2026-12-02T12:00:00Z'), scannedAt: at('2026-12-02T12:00:00Z'), paidCommission: 3 });
  assert.equal(m.paid?.isLabel, true);
  assert.equal(m.shortfall, 0);
});

test('carrierScanLine gives both dates', () => {
  assert.equal(carrierScanLine(at('2026-12-04T22:30:00Z'), at('2026-12-06T18:00:00Z')), 'Carrier delivered 2026-12-04; BG scanned 2026-12-06');
});
