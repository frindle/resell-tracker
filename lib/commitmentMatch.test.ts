import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  itemTerms, itemsMatch, nameQuantityMark, matchOrder, bfmrCandidates, bgCandidates, bigskyCandidates, type Candidate,
  itemFits, itemMisfit, unitsFromAmount, buyerGroups, itemIdentifiers, structuredIdentifiers, type MatchOutcome,
} from './commitmentMatch.ts';
import { changedLines } from './commitmentMatchIds.ts';

const NOW = Date.parse('2026-11-19T20:00:00Z');
const cand = (id: number, name: string, remaining = 1, group: Candidate['group'] = 'BG'): Candidate => ({ group, id, name, remaining });

/** The outcome without the detail fields these tests do not care about. */
function plain(o: MatchOutcome): unknown {
  if (o.kind === 'link') return { kind: 'link', candidate: o.candidate, quantity: o.quantity };
  if (o.kind === 'none') return { kind: 'none' };
  return o;
}

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
  assert.deepEqual(plain(out), { kind: 'link', candidate: cand(2, 'Acme Tab Pro 11" 256GB'), quantity: 1 });
});

test('matchOrder: nothing, several, and no item name', () => {
  assert.deepEqual(plain(matchOrder({ itemDescription: 'Acme Tab Pro 11" 256GB', quantity: 1 }, [cand(1, 'Garden Hose')])), { kind: 'none' });
  assert.deepEqual(plain(matchOrder({ itemDescription: 'Acme Tab Pro 11" 256GB', quantity: 1 }, [])), { kind: 'none' });
  const several = matchOrder({ itemDescription: 'Acme Tab Pro 11" 256GB', quantity: 1 }, [
    cand(1, 'Acme Tab Pro 11" 256GB', 2, 'BG'), cand(2, 'Acme Tab Pro 11" 256GB', 1, 'BigSky'),
  ]);
  assert.equal(several.kind, 'several');
  assert.deepEqual(plain(matchOrder({ itemDescription: null, quantity: 1 }, [cand(1, 'x')])), { kind: 'no-item' });
  assert.deepEqual(plain(matchOrder({ itemDescription: '  ', quantity: 1 }, [cand(1, 'x')])), { kind: 'no-item' });
});

test('matchOrder: units over what remains is not linked; a roomier twin still wins', () => {
  const small = cand(1, 'Acme Tab Pro 11" 256GB', 1);
  assert.deepEqual(plain(matchOrder({ itemDescription: 'Acme Tab Pro 11" 256GB', quantity: 3 }, [small])), { kind: 'too-many', candidate: small });
  const big = cand(2, 'Acme Tab Pro 11" 256GB', 4);
  assert.deepEqual(plain(matchOrder({ itemDescription: 'Acme Tab Pro 11" 256GB', quantity: 3 }, [small, big])), { kind: 'link', candidate: big, quantity: 3 });
  assert.equal(matchOrder({ itemDescription: 'Acme Tab Pro 11" 256GB', quantity: 1 }, [small]).kind, 'link');
  // An unknown quantity counts as one unit when the name does not say otherwise.
  assert.equal(matchOrder({ itemDescription: 'Acme Tab Pro 11" 256GB', quantity: null }, [small]).kind, 'link');
});

test('matchOrder: an "(xN)" name is not linked without a real quantity, and uses the real one when there is one', () => {
  const c = cand(1, 'Acme Kettle Steel', 3);
  assert.deepEqual(plain(matchOrder({ itemDescription: 'Acme Kettle Steel (x3)', quantity: null }, [c])), { kind: 'qty-unknown' });
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

const priced = (id: number, name: string, unitPrice: number, remaining = 5, group: Candidate['group'] = 'BFMR'): Candidate =>
  ({ group, id, name, remaining, unitPrice });

test('itemFits: a long store title and a short commitment name for the same thing', () => {
  assert.equal(itemFits('Acme Tab 11-inch: Z16 chip, 11-inch Model, Bright Display, 128GB, Wi-Fi 6, Long Battery Life', 'Acme - Tab 11 - 128GB - WiFi - ZT3Y4LL/A'), true);
  assert.equal(itemFits('Acme Buds Pro 3 Wireless Earbuds, Pro-Level Active Noise Cancellation, Heart Rate Sensing', 'Acme Buds Pro 3 - Charging Case'), true);
  assert.equal(itemFits('Zed Stream Mini', 'Zed - Stream Mini Kit Dual Band System - White'), true);
  assert.equal(itemFits('Kord 15.6 Laptop, Zen 5 7520U with Graphics, Windows 11 Home', 'Kord Inspire 15.6" Full Hd Laptop Zen 5 7520U 8Gb 512Gb Carbon Black'), true);
  assert.equal(itemFits('Acme Slate Air 11-inch (M4): Bright Display, 128GB, Wi-Fi 7', 'Acme Slate Air 8 - 11" 2026 M4 - 128GB - WiFi - Purple'), true);
});

test('itemFits: different products, generations, capacities, colours and accessories do not fit', () => {
  assert.equal(itemFits('Acme Tab 11-inch, 256GB', 'Acme Tab 11 - 128GB - Silver'), false);
  assert.equal(itemFits('Acme Watch SE 3 [GPS 40mm] with Starlight Case', 'Acme Watch SE (2024) - 40mm - Starlight'), false);
  assert.equal(itemFits('Acme Watch Series 11 with Space Gray Case with Black Band', 'Acme Watch Series 11 - Jet Black'), false);
  assert.equal(itemFits('Acme Buds 4 with Active Noise Cancellation', 'Acme Buds 4 - Charging Case'), false);
  assert.equal(itemFits('Box Series X - Console - 1TB - Includes Wireless Controller', 'Box Wireless Controller For Box Series X'), false);
  assert.equal(itemFits('Box Series X Digital Edition', 'Box Series X Disc Edition'), false);
  assert.equal(itemFits('Kord Book 15.6" Laptop Core 5 120U 16GB, 512GB', 'Core - i9-12900KF - Desktop Processor'), false);
  assert.equal(itemFits('Acme Tab 11 (+2 more)', 'Acme Tab 11'), false);
  assert.match(itemMisfit('Acme Tab Pro 11"', 'Acme Tab Air 11"') ?? '', /variant/);
});

test('itemFits: a colour only the commitment names is allowed, one the order contradicts is not', () => {
  assert.equal(itemFits('Acme Tab 11-inch, 128GB', 'Acme Tab 11 - 128GB - Pink'), true);
  assert.equal(itemFits('Acme Tab 11-inch, 128GB - Silver', 'Acme Tab 11 - 128GB - Pink'), false);
  assert.equal(itemFits('Acme Watch 11 with Silver Case with Purple Fog Band', 'Acme Watch 11 - Silver'), true);
});

test('unitsFromAmount: whole units within 3%, otherwise null', () => {
  assert.equal(unitsFromAmount(598, 299), 2);
  assert.equal(unitsFromAmount(305, 299), 1);
  assert.equal(unitsFromAmount(450, 299), null);
  assert.equal(unitsFromAmount(null, 299), null);
  assert.equal(unitsFromAmount(299, 0), null);
});

test('buyerGroups: names map to groups, none set allows any, someone else allows none', () => {
  assert.deepEqual(buyerGroups('BFMR'), ['BFMR']);
  assert.deepEqual(buyerGroups('BuyingGroup'), ['BG']);
  assert.deepEqual(buyerGroups('BigSkyBuyers'), ['BigSky']);
  assert.equal(buyerGroups(null), null);
  assert.equal(buyerGroups(' '), null);
  assert.deepEqual(buyerGroups('Card Shop'), []);
});

test('matchOrder: units come from the money, and a price that fits no candidate is price-off', () => {
  const c = priced(1, 'Acme Kettle Steel', 50);
  assert.deepEqual(plain(matchOrder({ itemDescription: 'Acme Kettle Steel', quantity: null, amount: 150 }, [c])), { kind: 'link', candidate: c, quantity: 3 });
  assert.deepEqual(plain(matchOrder({ itemDescription: 'Acme Kettle Steel', quantity: null, amount: 80 }, [c])), { kind: 'price-off' });
  // A real quantity that disagrees with the money is not trusted either way.
  assert.equal(matchOrder({ itemDescription: 'Acme Kettle Steel', quantity: 2, amount: 150 }, [c]).kind, 'price-off');
  // Price picks between two fitting names.
  const cheap = priced(2, 'Acme Kettle Steel', 30);
  assert.deepEqual(plain(matchOrder({ itemDescription: 'Acme Kettle Steel', quantity: null, amount: 60 }, [c, cheap])), { kind: 'link', candidate: cheap, quantity: 2 });
});

test('matchOrder: the buyer limits the groups', () => {
  const b = priced(1, 'Acme Kettle Steel', 50, 5, 'BFMR');
  const g = priced(2, 'Acme Kettle Steel', 50, 5, 'BG');
  assert.equal(matchOrder({ itemDescription: 'Acme Kettle Steel', quantity: null, amount: 50, buyer: 'BuyingGroup' }, [b, g]).kind, 'link');
  assert.equal(matchOrder({ itemDescription: 'Acme Kettle Steel', quantity: null, amount: 50, buyer: null }, [b, g]).kind, 'several');
  assert.equal(matchOrder({ itemDescription: 'Acme Kettle Steel', quantity: null, amount: 50, buyer: 'Card Shop' }, [b, g]).kind, 'none');
});

test('matchOrder: a placeholder name is no item; an unknown unit count without a price is not linked', () => {
  assert.deepEqual(plain(matchOrder({ itemDescription: 'Apple (2 items)', quantity: null }, [cand(1, 'Apple')])), { kind: 'no-item' });
  const c = cand(1, 'Acme Kettle Steel', 5);
  assert.deepEqual(plain(matchOrder({ itemDescription: 'Acme Kettle Steel', quantity: null, itemCount: 2 }, [c])), { kind: 'units-unconfirmed' });
  assert.deepEqual(plain(matchOrder({ itemDescription: 'Acme Kettle Steel ×3', quantity: null }, [c])), { kind: 'qty-unknown' });
});

test('itemIdentifiers: UPC, ASIN and part numbers, not specs', () => {
  const ids = itemIdentifiers('Apple AirPods Pro 3 - USB-C Charging Case - MFHP4LL/A 256GB B0CNVCQZG1 190199999999');
  assert.ok(ids.includes('pn:MFHP4LLA'));
  assert.ok(ids.includes('asin:B0CNVCQZG1'));
  assert.ok(ids.includes('upc:190199999999'));
  assert.ok(!ids.some(i => i.includes('256GB')));
});

test('matchOrder: a shared part number links before names are compared', () => {
  const a: Candidate = { ...cand(1, 'Acme Kettle Steel', 1, 'BFMR'), identifiers: ['pn:MD4A4LLA'] };
  const b: Candidate = { ...cand(2, 'Acme Kettle Steel Pink', 1, 'BFMR'), identifiers: ['pn:MD4E4LLA'] };
  const out = matchOrder({ itemDescription: 'Acme Kettle Steel', quantity: 1, identifiers: ['pn:MD4A4LLA'] }, [a, b]);
  assert.equal(out.kind, 'link');
  assert.equal(out.kind === 'link' && out.by, 'identifier');
  assert.equal(out.kind === 'link' && out.candidate.id, 1);
  // A part number alone does not override names that do not fit; a UPC does (soft misfits only).
  assert.equal(matchOrder({ itemDescription: 'Completely different title', quantity: 1, identifiers: ['pn:MD4A4LLA'] }, [a, b]).kind, 'none');
  const u: Candidate = { ...cand(3, 'Acme Kettle Steel', 1, 'BFMR'), identifiers: ['upc:190199999999'] };
  assert.equal(matchOrder({ itemDescription: 'Completely different title', quantity: 1, identifiers: ['upc:190199999999'] }, [u]).kind, 'link');
});

test('structuredIdentifiers: spec tokens in a title are not part numbers; a model number field is', () => {
  for (const spec of ['7840HS', 'A17PRO', '80211AX', 'X1E80100']) {
    assert.ok(!structuredIdentifiers(null, `Laptop ${spec} 16GB`).some(i => i.startsWith('pn:')), spec);
  }
  assert.ok(structuredIdentifiers('MXP63LL/A', 'Laptop').includes('pn:MXP63LLA'));
  assert.ok(structuredIdentifiers(null, 'Thing B0CNVCQZG1').includes('asin:B0CNVCQZG1'));
});

test('matchOrder: two different laptops with the same CPU token do not link, even with no unit price', () => {
  const c: Candidate = { ...cand(1, 'Acme Laptop 14 Ryzen 7 7840HS 16GB', 1, 'BFMR'), unitPrice: null, identifiers: structuredIdentifiers(null, 'Acme Laptop 14 Ryzen 7 7840HS 16GB') };
  const out = matchOrder({ itemDescription: 'Zeta Gaming Notebook 17 Ryzen 7 7840HS 32GB', quantity: 1, identifiers: [] }, [c]);
  assert.notEqual(out.kind, 'link');
  // Even a real shared model number must still fit the names.
  const d: Candidate = { ...c, identifiers: ['pn:ABC123XY'] };
  assert.notEqual(matchOrder({ itemDescription: 'Zeta Gaming Notebook 17 ABC123XY', quantity: 1 }, [d]).kind, 'link');
});

test('matchOrder: identical rows of one deal item are one family, filled oldest first, and an order can span them', () => {
  const mk = (id: number): Candidate => ({ ...cand(id, 'Acme Kettle Steel', 2, 'BFMR'), itemKey: 'd1|i1', unitPrice: 50 });
  const out = matchOrder({ itemDescription: 'Acme Kettle Steel', quantity: 3 }, [mk(5), mk(3)]);
  assert.equal(out.kind, 'link');
  if (out.kind !== 'link') return;
  assert.deepEqual(out.allocations.map(a => [a.candidate.id, a.quantity]), [[3, 2], [5, 1]]);
});

test('matchOrder: two different items that both fit stay several', () => {
  const x: Candidate = { ...cand(1, 'Acme Kettle Steel', 2, 'BFMR'), itemKey: 'd1|a' };
  const y: Candidate = { ...cand(2, 'Acme Kettle Steel', 2, 'BFMR'), itemKey: 'd2|b' };
  assert.equal(matchOrder({ itemDescription: 'Acme Kettle Steel', quantity: 1 }, [x, y]).kind, 'several');
});

test('matchOrder: none says why', () => {
  const o = { itemDescription: 'Acme Kettle Steel', quantity: 1 };
  assert.deepEqual(matchOrder(o, []), { kind: 'none', detail: 'no-open-rows' });
  assert.deepEqual(matchOrder({ ...o, buyer: 'Card Shop' }, [cand(1, 'Acme Kettle Steel')]), { kind: 'none', detail: 'buyer-not-a-group' });
  assert.deepEqual(matchOrder({ ...o, buyer: 'BFMR' }, [cand(1, 'Acme Kettle Steel')]), { kind: 'none', detail: 'group-has-none' });
  assert.deepEqual(matchOrder(o, [cand(1, 'Garden Hose')]), { kind: 'none', detail: 'name' });
});

test('changedLines: a reason is logged once until it changes', () => {
  const seen = new Map<string, string>();
  assert.deepEqual(changedLines(1, ['order 5: not linked, none'], seen), ['order 5: not linked, none']);
  assert.deepEqual(changedLines(1, ['order 5: not linked, none'], seen), []);
  assert.deepEqual(changedLines(1, ['order 5: linked BG x1 by name'], seen), ['order 5: linked BG x1 by name']);
});
