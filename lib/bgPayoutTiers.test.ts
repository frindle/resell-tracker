import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBgTierTime, bgPayoutTiers, tierEarned, reachableTier, underpaidTier, tierShortText } from './bgPayoutTiers.ts';

// Shaped like a BG commitment record on a "Tiered Payout" deal (synthetic values).
const tier = (label: string, commission: string, deliverBy: string, extra: Record<string, unknown> = {}) => ({
  key: label, tier_key: label, label, deliver_by: deliverBy, price: '100.00', commission,
  bg_points_reward: 0, total: (100 + Number(commission)).toFixed(2), is_base: label === 'Base', is_bg_label: false, ...extra,
});
const SPEED = JSON.stringify({
  commitment_id: 'CM-1', payout_tiers: [
    tier('Base', '2.00', '12-29-2026 07:59:59'),
    tier('Priority', '11.00', '12-05-2026 07:59:59'),
  ],
});
const LABEL = JSON.stringify({
  commitment_id: 'CM-2', payout_tiers: [
    tier('Base', '5.01', '12-20-2026 07:59:59'),
    tier('10+ BG Label', '3.01', '12-20-2026 07:59:59'),
  ],
});
const at = (s: string) => new Date(s);

test('parseBgTierTime reads the commitment format as UTC', () => {
  assert.equal(parseBgTierTime('12-05-2026 07:59:59')?.toISOString(), '2026-12-05T07:59:59.000Z');
  assert.equal(parseBgTierTime('12-05-2026'), null);
  assert.equal(parseBgTierTime(null), null);
});

test('bgPayoutTiers sorts soonest first and tolerates bad records', () => {
  const t = bgPayoutTiers(SPEED);
  assert.deepEqual(t.map(x => [x.label, x.commission, x.isBase]), [['Priority', 11, false], ['Base', 2, true]]);
  assert.deepEqual(bgPayoutTiers(null), []);
  assert.deepEqual(bgPayoutTiers('not json'), []);
  assert.deepEqual(bgPayoutTiers(JSON.stringify({ payout_tiers: [] })), []);
  assert.deepEqual(bgPayoutTiers(JSON.stringify({ payout_tiers: [{ label: 'x' }] })), []);
});

test('BG label tiers are recognised by flag or by name', () => {
  assert.deepEqual(bgPayoutTiers(LABEL).map(x => x.isLabel), [false, true]);
  const flagged = JSON.stringify({ payout_tiers: [tier('Shipping deal', '1.00', '12-20-2026 07:59:59', { is_bg_label: true })] });
  assert.equal(bgPayoutTiers(flagged)[0].isLabel, true);
});

test('tierEarned picks the best tier whose deadline the delivery makes', () => {
  const t = bgPayoutTiers(SPEED);
  assert.equal(tierEarned(t, at('2026-12-03T12:00:00Z'))?.label, 'Priority');
  assert.equal(tierEarned(t, at('2026-12-05T07:59:59Z'))?.label, 'Priority');
  assert.equal(tierEarned(t, at('2026-12-05T08:00:00Z'))?.label, 'Base');
  assert.equal(tierEarned(t, at('2026-12-30T00:00:00Z')), null);
  // A label tier is never "earned" by speed.
  assert.equal(tierEarned(bgPayoutTiers(LABEL), at('2026-12-01T00:00:00Z'))?.label, 'Base');
});

test('reachableTier shows the faster tier only while it is still worth more', () => {
  const t = bgPayoutTiers(SPEED);
  assert.equal(reachableTier(t, 2, at('2026-11-23T00:00:00Z'))?.label, 'Priority');
  assert.equal(reachableTier(t, 11, at('2026-11-23T00:00:00Z')), null);
  assert.equal(reachableTier(t, 2, at('2026-12-06T00:00:00Z')), null);
  assert.equal(reachableTier(bgPayoutTiers(LABEL), 5.01, at('2026-11-23T00:00:00Z')), null);
  assert.equal(reachableTier([], 2, at('2026-11-23T00:00:00Z')), null);
});

test('underpaidTier flags a fulfilment inside the Priority deadline still paid Base', () => {
  const t = bgPayoutTiers(SPEED);
  assert.equal(underpaidTier(t, 2, at('2026-12-01T00:00:00Z'))?.label, 'Priority');
  assert.equal(underpaidTier(t, 11, at('2026-12-01T00:00:00Z')), null);
  assert.equal(underpaidTier(t, 2, at('2026-12-06T00:00:00Z')), null);
});

test('underpaidTier never fires on label-only deals or a commission matching a label tier', () => {
  assert.equal(underpaidTier(bgPayoutTiers(LABEL), 3.01, at('2026-12-01T00:00:00Z')), null);
  assert.equal(underpaidTier(bgPayoutTiers(LABEL), 0, at('2026-12-01T00:00:00Z')), null);
  const mixed = JSON.stringify({ payout_tiers: [
    tier('Base', '2.00', '12-29-2026 07:59:59'),
    tier('Priority', '11.00', '12-05-2026 07:59:59'),
    tier('BG Label', '1.00', '12-29-2026 07:59:59'),
  ] });
  assert.equal(underpaidTier(bgPayoutTiers(mixed), 1, at('2026-12-01T00:00:00Z')), null);
  assert.equal(underpaidTier(bgPayoutTiers(mixed), 2, at('2026-12-01T00:00:00Z'))?.label, 'Priority');
});

test('tierShortText states the gap', () => {
  const t = bgPayoutTiers(SPEED);
  const txt = tierShortText('Acme Console', 'CM-1', 2, t[0], 2, at('2026-12-01T10:00:00Z'));
  assert.match(txt, /fulfilled 2026-12-01/);
  assert.match(txt, /\$2\.00 commission instead of \$11\.00/);
  assert.match(txt, /Short \$18\.00 on 2 units/);
});
