import test from 'node:test';
import assert from 'node:assert/strict';

import { cityState, matchShippingRule } from './shippingRuleMatch.ts';

// Made-up addresses in the shapes the tracker sees.
const RULES = [
  { id: 1, pattern: '12 Commerce Dr Ste 5, New Castle, DE 19720', buyerId: 2 },
  { id: 3, pattern: '40 Depot Rd Unit 9', buyerId: 1 },
  { id: 7, pattern: 'Hudson, US-NH, 03051-4905', buyerId: 1 },
  { id: 8, pattern: '9 Elm St, Portland, ME 04101', buyerId: 3 },
  { id: 9, pattern: 'Unassigned Rd, Dover, DE', buyerId: null },
];

test('a rule pattern inside the address still wins', () => {
  assert.equal(matchShippingRule('Pat Doe\n40 Depot Rd Unit 9, Hudson, NH 03051', RULES)?.id, 3);
});

test('Amazon "Name - City, ST" matches the group in that city', () => {
  assert.equal(matchShippingRule('Pat Doe - NEW CASTLE, DE', RULES)?.buyerId, 2);
  assert.equal(matchShippingRule('Pat Doe - Hudson, NH', RULES)?.buyerId, 1);
  assert.equal(matchShippingRule('Pat - new castle, de', RULES)?.buyerId, 2);
});

test('the state must agree with the one the rule names', () => {
  assert.equal(matchShippingRule('Pat Doe - Portland, OR', RULES), undefined);
  assert.equal(matchShippingRule('Pat Doe - Portland, ME', RULES)?.buyerId, 3);
  assert.equal(matchShippingRule('Pat Doe - Hudson, NY', RULES), undefined);
});

test('a full address needs the same street number as the rule', () => {
  // Another street in a group's city is not that group.
  assert.equal(matchShippingRule('Pat Doe, 77 Oak Ave, New Castle, DE 19720', RULES), undefined);
  assert.equal(matchShippingRule('Pat Doe, 12 Commerce Drive Suite 5, New Castle, DE 19720', RULES)?.buyerId, 2);
});

test('Lenovo style "…, City, US-NH, 03051-4905" parses', () => {
  assert.deepEqual(cityState('40 Depot Road, Hudson, US-NH, 03051-4905'), { city: 'hudson', state: 'NH' });
  assert.deepEqual(cityState('40 Depot Road, Hudson, NH-US, 03051-4905'), { city: 'hudson', state: 'NH' });
  assert.deepEqual(cityState('Hudson NH 03051'), { city: 'hudson', state: 'NH' });
  assert.deepEqual(cityState('Pat Doe - New Castle, DE, United States'), { city: 'new castle', state: 'DE' });
});

test('no match: unknown city, part of a word, no state, empty', () => {
  assert.equal(matchShippingRule('Pat Doe - Springfield, IL', RULES), undefined);
  assert.equal(matchShippingRule('Pat Doe - Hudsonville, NH', RULES), undefined);
  assert.equal(matchShippingRule('Pat Doe - Hudson', RULES), undefined);
  assert.equal(matchShippingRule('', RULES), undefined);
  assert.equal(matchShippingRule(null, RULES), undefined);
});

test('a city two groups share is left for a person', () => {
  const rules = [...RULES, { id: 10, pattern: '5 Mill St, New Castle, DE 19720', buyerId: 1 }];
  assert.equal(matchShippingRule('Pat Doe - New Castle, DE', rules), undefined);
  // Two rules for the same group are fine.
  const same = [...RULES, { id: 11, pattern: '5 Mill St, New Castle, DE 19720', buyerId: 2 }];
  assert.equal(matchShippingRule('Pat Doe - New Castle, DE', same)?.buyerId, 2);
});

test('a rule with no buyer never assigns by city, and an empty pattern matches nothing', () => {
  assert.equal(matchShippingRule('Pat Doe - Dover, DE', RULES), undefined);
  assert.equal(matchShippingRule('Pat Doe - Hudson, NH', [{ pattern: '  ', buyerId: 4 }]), undefined);
});
