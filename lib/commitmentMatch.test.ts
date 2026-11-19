import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  itemTerms, itemsMatch, nameQuantityMark, matchOrder, bfmrCandidates, bgCandidates, bigskyCandidates, type Candidate,
} from './commitmentMatch.ts';

const NOW = Date.parse('2026-11-19T20:00:00Z');
const cand = (id: number, name: string, remaining = 1, group: Candidate['group'] = 'BG'): Candidate => ({ group, id, name, remaining });

test('itemTerms: capacity, size, model, variants and modifiers are split out', () => {
  const t = itemTerms('Acme Tab Pro 11" 256GB (3rd generation) Wi-Fi Blue');
  assert.deepEqual([...t.capacity], ['256gb']);
  assert.deepEqual([...t.size], ['11in']);
  assert.deepEqual([...t.model], ['3']);
  assert.deepEqual([...t.variants], ['pro']);
  assert.deepEqual([...t.modifiers].sort(), ['blue', 'wifi']);
  assert.ok(t.words.has('acme') && t.words.has('tab'));
  assert.deepEqual([...itemTerms('Widget 13-inch 1 TB').size], ['13in']);
  assert.deepEqual([...itemTerms('Widget 1 TB').capacity], ['1tb']);
});

test('nameQuantityMark: reads a count marker, defaults to one', () => {
  assert.equal(nameQuantityMark('Acme Kettle (x3)'), 3);
  assert.equal(nameQuantityMark('Acme Kettle Black x2'), 2);
  assert.equal(nameQuantityMark('Acme Kettle'), 1);
  assert.equal(nameQuantityMark('Acme Model X3 Kettle'), 1);
});

test('itemsMatch: the same product under different wording', () => {
  assert.ok(itemsMatch('Acme Tab Pro 11-inch 256GB', 'Acme Tab Pro 11" 256GB'));
  assert.ok(itemsMatch('Zed Buds Pro (3rd generation)', 'Zed Buds Pro 3'));
  assert.ok(itemsMatch('Acme Tab Pro 11" 256GB Blue Wi-Fi', 'Acme Tab Pro 11-inch 256GB Wifi Blue'));
  // The count marker is not part of the product.
  assert.ok(itemsMatch('Acme Kettle Steel (x1)', 'Acme Kettle Steel'));
});

test('itemsMatch: size, capacity, generation and variant differences are different products', () => {
  assert.equal(itemsMatch('Acme Tab Pro 11" 256GB', 'Acme Tab Pro 13" 256GB'), false);
  assert.equal(itemsMatch('Acme Tab Pro 11" 256GB', 'Acme Tab Pro 11" 512GB'), false);
  assert.equal(itemsMatch('Zed Buds Pro 3', 'Zed Buds Pro 2'), false);
  assert.equal(itemsMatch('Zed Phone Pro', 'Zed Phone Pro Max'), false);
  assert.equal(itemsMatch('Zed Phone', 'Zed Phone Pro'), false);
  assert.equal(itemsMatch('Zed Phone a2894', 'Zed Phone a3000'), false);
});

// One test per false-match pair from the review (synthetic names).
test('itemsMatch: a colour on one side only, or two colours, do not match', () => {
  assert.equal(itemsMatch('Acme Tab Pro 11" 256GB Blue', 'Acme Tab Pro 11" 256GB Purple'), false);
  assert.equal(itemsMatch('Acme Tab Pro 11" 256GB Blue', 'Acme Tab Pro 11" 256GB'), false);
  assert.equal(itemsMatch('Acme Tab Pro 11" 256GB Space Grey', 'Acme Tab Pro 11" 256GB Space Gray'), true);
});
test('itemsMatch: Wi-Fi + Cellular is not Wi-Fi', () => {
  assert.equal(itemsMatch('Acme Tab Air 11" 128GB Wi-Fi + Cellular', 'Acme Tab Air 11" 128GB Wi-Fi'), false);
  assert.equal(itemsMatch('Acme Tab Air 11" 128GB Wi-Fi', 'Acme Tab Air 11" 128GB'), false);
});
test('itemsMatch: a model-suffix code is not the plain number', () => {
  assert.equal(itemsMatch('Zed Phone 16e 128GB', 'Zed Phone 16 128GB'), false);
  assert.equal(itemsMatch('Zed Phone 16e 128GB', 'Zed Phone 16e 128GB'), true);
});
test('itemsMatch: Digital Edition is not Disc Edition', () => {
  assert.equal(itemsMatch('Play Console Digital Edition 1TB', 'Play Console Disc Edition 1TB'), false);
  assert.equal(itemsMatch('Play Console Digital Edition 1TB', 'Play Console 1TB'), false);
});
test('itemsMatch: a bundle is not the bare item', () => {
  assert.equal(itemsMatch('Play Console 1TB Bundle with Extra Controller', 'Play Console 1TB'), false);
  assert.equal(itemsMatch('Play Console 1TB + Game', 'Play Console 1TB'), false);
  assert.equal(itemsMatch('Zed Buds Pro 2-Pack', 'Zed Buds Pro'), false);
  assert.equal(itemsMatch('Zed Buds Pro Refurbished', 'Zed Buds Pro'), false);
});

test('itemsMatch: unrelated names and empty names do not match', () => {
  assert.equal(itemsMatch('Garden Hose 50ft', 'Acme Tab Pro 11"'), false);
  assert.equal(itemsMatch('', 'Acme Tab'), false);
  assert.equal(itemsMatch(null, null), false);
  // One shared plain word is not enough.
  assert.equal(itemsMatch('Acme Kettle', 'Acme Tab'), false);
  // Extra descriptive words on one side are not enough either.
  assert.equal(itemsMatch('Acme Kettle Steel Boil', 'Acme Kettle Glass Boil'), false);
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
  assert.equal(matchOrder({ itemDescription: 'Acme Tab Pro 11" 256GB', quantity: 1 }, [small]).kind, 'link');
  // An unknown quantity counts as one unit when the name does not say otherwise.
  assert.equal(matchOrder({ itemDescription: 'Acme Tab Pro 11" 256GB', quantity: null }, [small]).kind, 'link');
});

test('matchOrder: an "(xN)" name is not linked without a real quantity, and uses the real one when there is one', () => {
  const c = cand(1, 'Acme Kettle Steel', 3);
  assert.deepEqual(matchOrder({ itemDescription: 'Acme Kettle Steel (x3)', quantity: null }, [c]), { kind: 'qty-unknown' });
  assert.equal(matchOrder({ itemDescription: 'Acme Kettle Steel (x3)', quantity: 3 }, [c]).kind, 'link');
  assert.equal(matchOrder({ itemDescription: 'Acme Kettle Steel (x3)', quantity: 4 }, [c]).kind, 'too-many');
});

test('matchOrder: only candidates that existed on the order day; unknown dates never link', () => {
  const day = (d: string) => Date.parse(d + 'T00:00:00Z');
  const o = { itemDescription: 'Acme Kettle Steel', quantity: 1, orderDateMs: day('2026-11-10') };
  const mk = (createdAt: number | null | undefined) => ({ ...cand(1, 'Acme Kettle Steel', 2), createdAt });
  assert.equal(matchOrder(o, [mk(day('2026-11-10') + 5 * 3600_000)]).kind, 'link'); // same day
  assert.equal(matchOrder(o, [mk(day('2026-11-11'))]).kind, 'none'); // commitment came after the order
  assert.equal(matchOrder(o, [mk(null)]).kind, 'none'); // date unknown
  assert.equal(matchOrder(o, [mk(undefined)]).kind, 'link'); // group without a date (BFMR)
  assert.equal(matchOrder({ ...o, orderDateMs: null }, [mk(day('2026-11-01'))]).kind, 'none');
});

test('bfmrCandidates: only unlinked reservations still waiting for their order', () => {
  const row = (id: number, status: string, linkCount = 0) => ({ id, itemName: 'Acme Tab', dealTitle: null, qty: 2, status, linkCount });
  const out = bfmrCandidates([
    row(1, 'reserved'), row(2, 'purchased'), row(3, 'Reserved', 1),
    row(4, 'paid'), row(5, 'shipped'), row(6, 'processed'), row(7, 'pkg_received'), row(8, 'returned'),
    row(9, 'set_aside'), row(10, 'cancelled'), row(11, 'closed'), row(12, 'deadline'),
  ]);
  assert.deepEqual(out.map(c => c.id), [1, 2]);
  assert.equal(bfmrCandidates([{ id: 1, itemName: null, dealTitle: 'Deal Title', qty: 1, status: 'reserved', linkCount: 0 }])[0].name, 'Deal Title');
});

test('bgCandidates: count minus ALL assigned units (fulfilled is part of assigned), open and not expired', () => {
  const row = (o: Partial<Parameters<typeof bgCandidates>[0][number]>) =>
    ({ id: 1, dealTitle: 'Acme Tab', count: 5, assignedQty: 2, status: 'ACTIVE', expiryDay: null, createdDt: null, ...o });
  const out = bgCandidates([
    row({ id: 1 }),
    row({ id: 2, assignedQty: 5 }),
    row({ id: 3, expiryDay: new Date('2026-11-18T00:00:00Z') }),
    row({ id: 4, expiryDay: new Date('2026-11-19T00:00:00Z') }),
    row({ id: 5, status: 'FULFILLED' }),
    row({ id: 6, status: 'PARTIALLY FULFILLED' }),
  ], NOW);
  assert.deepEqual(out.map(c => [c.id, c.remaining]), [[1, 3], [4, 3], [6, 3]]);
});

test('bigskyCandidates: committed minus fulfilled minus units already set aside, open, not past its expiry day', () => {
  const row = (o: Partial<Parameters<typeof bigskyCandidates>[0][number]>) =>
    ({ id: 1, itemName: 'Acme Tab', commitmentAmount: 5, fulfilled: 1, plannedQty: 1, status: 'UNFULFILLED', dealExpiration: null, dealCreated: null, creationDate: null, ...o });
  const out = bigskyCandidates([
    row({ id: 1 }),
    row({ id: 2, plannedQty: 4 }), // set aside units use it up
    row({ id: 3, dealExpiration: new Date('2026-11-18T00:00:00Z') }),
    row({ id: 4, dealExpiration: new Date('2026-11-19T12:00:00Z') }),
    row({ id: 5, status: 'FULFILLED' }),
  ], NOW);
  assert.deepEqual(out.map(c => [c.id, c.remaining]), [[1, 3], [4, 3]]);
  // BigSky's own commitmentsRemaining is not used.
  assert.equal('commitmentsRemaining' in row({}), false);
});

test('itemsMatch: a model word only one side has is a different product', () => {
  assert.equal(itemsMatch('Xbox Series X 1TB', 'Series S 1TB'), false);
  assert.equal(itemsMatch('Switch OLED Model', 'Switch'), false);
  assert.equal(itemsMatch('Steam Deck OLED 512GB', 'Steam Deck 512GB'), false);
  assert.equal(itemsMatch('PS5 Console Slim', 'PS5 Console'), false);
  assert.equal(itemsMatch('AirPods 4 Active Noise Cancellation', 'AirPods 4'), false);
  // and the other way round
  assert.equal(itemsMatch('Series S 1TB', 'Xbox Series X 1TB'), false);
  assert.equal(itemsMatch('Switch', 'Switch OLED Model'), false);
});

test('itemsMatch: one-letter words count, the same names still match', () => {
  assert.equal(itemsMatch('Xbox Series X 1TB', 'Xbox Series S 1TB'), false);
  assert.equal(itemsMatch('Xbox Series X 1TB', 'Xbox Series X 1TB'), true);
  assert.equal(itemsMatch("Acme Chef's Kettle 2", 'Acme Chef Kettle 2'), true);
  assert.equal(itemsMatch('Steam Deck OLED 512GB', 'Steam Deck OLED 512GB'), true);
  assert.equal(itemsMatch('PS5 Console Slim', 'PS5 Slim Console'), true);
});
