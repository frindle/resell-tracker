import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  itemTerms, itemsMatch, matchOrder, bfmrCandidates, bgCandidates, bigskyCandidates, type Candidate,
} from './commitmentMatch.ts';

const NOW = Date.parse('2026-11-19T20:00:00Z');
const cand = (id: number, name: string, remaining = 1, group: Candidate['group'] = 'BG'): Candidate => ({ group, id, name, remaining });

test('itemTerms: capacity, size, generation and variants are split out', () => {
  const t = itemTerms('Acme Tab Pro 11" 256GB (3rd generation) Wi-Fi');
  assert.deepEqual([...t.capacity], ['256gb']);
  assert.deepEqual([...t.size], ['11in']);
  assert.deepEqual([...t.generation], ['3']);
  assert.deepEqual([...t.variants], ['pro']);
  assert.ok(t.words.has('acme') && t.words.has('tab'));
  assert.deepEqual([...itemTerms('Widget 13-inch 1 TB').size], ['13in']);
  assert.deepEqual([...itemTerms('Widget 1 TB').capacity], ['1tb']);
});

test('itemsMatch: the same product under different wording', () => {
  assert.ok(itemsMatch('Acme Tab Pro 11-inch 256GB Space Gray', 'Acme Tab Pro 11" 256GB'));
  assert.ok(itemsMatch('Zed Buds Pro (3rd generation)', 'Zed Buds Pro 3'));
});

test('itemsMatch: size, capacity, generation and variant differences are different products', () => {
  assert.equal(itemsMatch('Acme Tab Pro 11" 256GB', 'Acme Tab Pro 13" 256GB'), false);
  assert.equal(itemsMatch('Acme Tab Pro 11" 256GB', 'Acme Tab Pro 11" 512GB'), false);
  assert.equal(itemsMatch('Zed Buds Pro 3', 'Zed Buds Pro 2'), false);
  assert.equal(itemsMatch('Zed Phone Pro', 'Zed Phone Pro Max'), false);
  assert.equal(itemsMatch('Zed Phone', 'Zed Phone Pro'), false);
  assert.equal(itemsMatch('Zed Phone a2894', 'Zed Phone a3000'), false);
});

test('itemsMatch: unrelated names and empty names do not match', () => {
  assert.equal(itemsMatch('Garden Hose 50ft', 'Acme Tab Pro 11"'), false);
  assert.equal(itemsMatch('', 'Acme Tab'), false);
  assert.equal(itemsMatch(null, null), false);
  // One shared plain word is not enough.
  assert.equal(itemsMatch('Acme Kettle', 'Acme Tab'), false);
});

test('matchOrder: exactly one match links', () => {
  const out = matchOrder({ itemDescription: 'Acme Tab Pro 11" 256GB', quantity: 1 }, [
    cand(1, 'Acme Tab Pro 13" 256GB'), cand(2, 'Acme Tab Pro 11" 256GB'), cand(3, 'Garden Hose'),
  ]);
  assert.deepEqual(out, { kind: 'link', candidate: cand(2, 'Acme Tab Pro 11" 256GB') });
});

test('matchOrder: nothing, several, and no item name', () => {
  assert.deepEqual(matchOrder({ itemDescription: 'Acme Tab Pro 11" 256GB', quantity: 1 }, [cand(1, 'Garden Hose')]), { kind: 'none' });
  assert.deepEqual(matchOrder({ itemDescription: 'Acme Tab Pro 11" 256GB', quantity: 1 }, []), { kind: 'none' });
  const several = matchOrder({ itemDescription: 'Acme Tab Pro 11" 256GB', quantity: 1 }, [
    cand(1, 'Acme Tab Pro 11" 256GB', 2, 'BG'), cand(2, 'Acme Tab Pro 11" 256GB', 1, 'BigSky'),
  ]);
  assert.equal(several.kind, 'several');
  assert.deepEqual(matchOrder({ itemDescription: null, quantity: 1 }, [cand(1, 'x')]), { kind: 'no-item' });
  assert.deepEqual(matchOrder({ itemDescription: '  ', quantity: 1 }, [cand(1, 'x')]), { kind: 'no-item' });
});

test('matchOrder: units over what remains is not linked; a roomier twin still wins', () => {
  const small = cand(1, 'Acme Tab Pro 11" 256GB', 1);
  assert.deepEqual(matchOrder({ itemDescription: 'Acme Tab Pro 11" 256GB', quantity: 3 }, [small]), { kind: 'too-many', candidate: small });
  const big = cand(2, 'Acme Tab Pro 11" 256GB', 4);
  assert.deepEqual(matchOrder({ itemDescription: 'Acme Tab Pro 11" 256GB', quantity: 3 }, [small, big]), { kind: 'link', candidate: big });
  // Exactly what remains fits.
  assert.equal(matchOrder({ itemDescription: 'Acme Tab Pro 11" 256GB', quantity: 1 }, [small]).kind, 'link');
  // A missing or odd quantity counts as one unit.
  assert.equal(matchOrder({ itemDescription: 'Acme Tab Pro 11" 256GB', quantity: 0 }, [small]).kind, 'link');
});

test('bfmrCandidates: only unlinked, not cancelled', () => {
  const rows = [
    { id: 1, itemName: 'Acme Tab', dealTitle: null, qty: 2, status: 'reserved', linkCount: 0 },
    { id: 2, itemName: 'Acme Tab', dealTitle: null, qty: 2, status: 'reserved', linkCount: 1 },
    { id: 3, itemName: null, dealTitle: 'Deal Title', qty: 1, status: 'Cancelled', linkCount: 0 },
    { id: 4, itemName: null, dealTitle: 'Deal Title', qty: 1, status: 'closed', linkCount: 0 },
    { id: 5, itemName: null, dealTitle: 'Deal Title', qty: 1, status: 'reserved', linkCount: 0 },
  ];
  assert.deepEqual(bfmrCandidates(rows).map(c => [c.id, c.name, c.remaining]), [[1, 'Acme Tab', 2], [5, 'Deal Title', 1]]);
});

test('bgCandidates: count minus fulfilled minus linked above zero, open and not expired', () => {
  const row = (o: Partial<Parameters<typeof bgCandidates>[0][number]>) =>
    ({ id: 1, dealTitle: 'Acme Tab', count: 5, fulfilled: 1, linkedQty: 1, status: 'ACTIVE', expiryDay: null, ...o });
  const out = bgCandidates([
    row({ id: 1 }),
    row({ id: 2, fulfilled: 2, linkedQty: 3 }),
    row({ id: 3, expiryDay: new Date('2026-11-18T00:00:00Z') }),
    row({ id: 4, expiryDay: new Date('2026-11-19T00:00:00Z') }),
    row({ id: 5, status: 'FULFILLED' }),
    row({ id: 6, status: 'PARTIALLY FULFILLED' }),
  ], NOW);
  assert.deepEqual(out.map(c => [c.id, c.remaining]), [[1, 3], [4, 3], [6, 3]]);
});

test('bigskyCandidates: remaining above zero and not past its expiry day', () => {
  const out = bigskyCandidates([
    { id: 1, itemName: 'Acme Tab', commitmentsRemaining: 2, dealExpiration: null },
    { id: 2, itemName: 'Acme Tab', commitmentsRemaining: 0, dealExpiration: null },
    { id: 3, itemName: 'Acme Tab', commitmentsRemaining: 2, dealExpiration: new Date('2026-11-18T00:00:00Z') },
    { id: 4, itemName: 'Acme Tab', commitmentsRemaining: 2, dealExpiration: new Date('2026-11-19T12:00:00Z') },
  ], NOW);
  assert.deepEqual(out.map(c => c.id), [1, 4]);
});
