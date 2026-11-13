import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// Same trick as cardcenter.test.ts: stub the `@/` imports lib/cardcenter.ts needs.
const hooks = `
const stubs = {
  '@/lib/db': 'export const getSetting = async () => null; export const upsertSetting = async () => {};',
  '@/lib/apiCallLog': 'export const loggedFetch = (_ctx, url, init) => globalThis.fetch(url, init);',
};
export async function resolve(specifier, context, next) {
  if (stubs[specifier]) return { url: 'data:text/javascript,' + encodeURIComponent(stubs[specifier]), shortCircuit: true };
  return next(specifier, context);
}
`;
register('data:text/javascript,' + encodeURIComponent(hooks));

const { ccApiFetch, uploadCommentFile, postReservationComment } = await import('./cardcenter.ts');
const { sendCardImages, sendImagesForCards, autoSendImages } = await import('./cardcenterImages.ts');
const { backfillCardImages, planLinks, BACKFILL_MAX_RESERVATIONS } = await import('./cardcenterImagesBackfill.ts');
import type { ImageCard, ImageDeps } from './cardcenterImages.ts';
import type { BackfillDeps, UnlinkedPhoto, OrderCard } from './cardcenterImagesBackfill.ts';

// Made-up codes. Never real.
const CODE_A = '4111222233331234';
const CODE_B = '5999888877775678';
const auth = { userId: 1, email: 'a@b.c', password: 'pw' };

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
const realFetch = globalThis.fetch;
const realWarn = console.warn;
let calls: Call[] = [];
let warnings: string[] = [];
let failUpload = false;
let failComment = false;
let nextFileId = 100;

const json = (body: unknown, status = 200, cookie?: string) => {
  const h = new Headers({ 'content-type': 'application/json' });
  if (cookie) h.append('set-cookie', cookie);
  return new Response(JSON.stringify(body), { status, headers: h });
};

function install() {
  calls = []; warnings = []; failUpload = false; failComment = false; nextFileId = 100;
  console.warn = (...a: unknown[]) => { warnings.push(a.join(' ')); };
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    const call: Call = { url, method: (init.method ?? 'GET').toUpperCase(), headers: { ...(init.headers as Record<string, string> | undefined) }, body: init.body };
    calls.push(call);
    if (url.endsWith('/Account/Login') && call.method === 'GET') {
      const h = new Headers({ 'content-type': 'text/html' });
      h.append('set-cookie', 'AF=a; path=/');
      return new Response('<script>window.token = {"requestToken":"t1"};</script>', { status: 200, headers: h });
    }
    if (url.endsWith('/Api/Account/Login')) return json({}, 200, 'SESS=s; path=/');
    if (url.endsWith('/Api/AntiforgeryTokens')) return json({ requestToken: 't2' });
    if (url.endsWith('/Api/Comments/Files')) return failUpload ? json({ title: 'boom' }, 500) : json({ id: `f${nextFileId++}` });
    if (/\/Api\/Reservations\/\d+\/Comments$/.test(url)) return failComment ? json({}, 500) : json({ id: 1 });
    return json({});
  }) as typeof fetch;
}
test.afterEach(() => { globalThis.fetch = realFetch; console.warn = realWarn; });

const uploads = () => calls.filter(c => c.url.endsWith('/Api/Comments/Files'));
const comments = () => calls.filter(c => /\/Comments$/.test(c.url) && !c.url.endsWith('/Files'));
const fileName = (c: Call) => ((c.body as FormData).get('file') as File).name;

function memDeps(cards: ImageCard[]): ImageDeps & { settings: Record<string, string> } {
  const settings: Record<string, string> = {};
  return {
    settings,
    getSetting: async (_u, k) => (k in settings ? { value: settings[k] } : null),
    loadCards: async (_u, ids) => cards.filter(c => ids.includes(c.id)),
    readPhoto: async () => Buffer.from('fake-bytes'),
    toJpeg: async b => b,
    markSent: async (ids, at) => { for (const c of cards) if (ids.includes(c.id)) c.ccImagesSentAt = at; },
  };
}
const photo = (id: number, orderId = 1) => ({ id, orderId, filename: `p${id}.jpg`, originalName: `IMG_${id}.heic`, mimeType: 'image/heic', rotation: 90 });
const card = (id: number, code: string, photos: number[], reservation = 7): ImageCard =>
  ({ id, cardNumber: code, ccReservationId: reservation, ccImagesSentAt: null, photos: photos.map(p => photo(p)) });

test('ccApiFetch leaves Content-Type to fetch for FormData but sets JSON otherwise', async () => {
  install();
  const fd = new FormData();
  fd.append('file', new Blob(['x']), 'a.jpg');
  await ccApiFetch(1, 'a@b.c', 'pw', '/Api/Ping', { method: 'POST', body: fd });
  await ccApiFetch(1, 'a@b.c', 'pw', '/Api/Ping', { method: 'POST', body: '{}' });
  const pings = calls.filter(c => c.url.endsWith('/Api/Ping'));
  assert.equal(pings[0].headers['Content-Type'], undefined);
  assert.equal(pings[1].headers['Content-Type'], 'application/json');
});

test('uploadCommentFile posts field "file" to /Api/Comments/Files and returns the id', async () => {
  install();
  const r = await uploadCommentFile(auth, { bytes: new Uint8Array([1, 2]), filename: 'card-1234.jpg', mimeType: 'image/jpeg' });
  assert.equal(r.id, 'f100');
  const [u] = uploads();
  assert.equal(u.method, 'POST');
  assert.ok(u.body instanceof FormData);
  assert.equal(fileName(u), 'card-1234.jpg');
  assert.equal(u.headers['Accept'], 'application/json');
  assert.equal(u.headers['Content-Type'], undefined);
});

test('postReservationComment body shape', async () => {
  install();
  await postReservationComment(auth, 7, 'Images attached.', ['f1', 'f2']);
  const [c] = comments();
  assert.ok(c.url.endsWith('/Api/Reservations/7/Comments'));
  assert.deepEqual(JSON.parse(c.body as string), { body: 'Images attached.', private: false, files: [{ id: 'f1' }, { id: 'f2' }] });
});

test('sends one comment per reservation; names and text carry last 4 only; no-photo cards skipped', async () => {
  install();
  const cards = [card(1, CODE_A, [1, 2]), card(2, CODE_B, [3]), card(3, '9000000000009999', [])];
  const r = await sendCardImages(auth, 7, cards, {}, memDeps(cards));
  assert.deepEqual(r.sent, [1, 2]);
  assert.deepEqual(r.skippedNoPhoto, [3]);
  assert.deepEqual(uploads().map(fileName), ['card-1234.jpg', 'card-1234-2.jpg', 'card-5678.jpg']);
  assert.equal(comments().length, 1);
  const c = JSON.parse(comments()[0].body as string);
  assert.equal(c.body, 'Card images: …1234, …5678');
  assert.equal(c.files.length, 3);
  const everything = JSON.stringify(calls.map(x => [x.url, x.body instanceof FormData ? fileName(x) : x.body])) + warnings.join('');
  for (const code of [CODE_A, CODE_B]) assert.ok(!everything.includes(code));
});

test('ccImagesSentAt makes a re-run a no-op; force overrides', async () => {
  install();
  const cards = [card(1, CODE_A, [1])];
  const deps = memDeps(cards);
  assert.deepEqual((await sendCardImages(auth, 7, cards, {}, deps)).sent, [1]);
  assert.ok(cards[0].ccImagesSentAt);
  calls = [];
  const again = await sendCardImages(auth, 7, cards, {}, deps);
  assert.deepEqual(again.sent, []);
  assert.deepEqual(again.alreadySent, [1]);
  assert.equal(calls.length, 0);
  assert.deepEqual((await sendCardImages(auth, 7, cards, { force: true }, deps)).sent, [1]);
});

test('a failing upload is reported, not stamped, never throws; auto-send leaves submit untouched', async () => {
  install();
  failUpload = true;
  const cards = [card(1, CODE_A, [1])];
  const deps = memDeps(cards);
  const r = await autoSendImages(1, auth, [1], deps);
  assert.ok(!('disabled' in r));
  assert.deepEqual((r as { failed: number[] }).failed, [1]);
  assert.equal(cards[0].ccImagesSentAt, null);
  assert.equal(comments().length, 0);
  assert.ok(!warnings.join('').includes(CODE_A));
  // even a loader that explodes must not throw
  const boom = { ...deps, loadCards: async () => { throw new Error('db down'); } };
  const r2 = await autoSendImages(1, auth, [1], boom) as { error?: string };
  assert.match(r2.error!, /db down/);
});

test('a failing comment marks the group failed and unstamped', async () => {
  install();
  failComment = true;
  const cards = [card(1, CODE_A, [1])];
  const r = await sendCardImages(auth, 7, cards, {}, memDeps(cards));
  assert.deepEqual(r.failed, [1]);
  assert.equal(cards[0].ccImagesSentAt, null);
});

test('cc_send_images=false disables auto-send; unset means on', async () => {
  install();
  const cards = [card(1, CODE_A, [1])];
  const deps = memDeps(cards);
  deps.settings.cc_send_images = 'false';
  assert.deepEqual(await autoSendImages(1, auth, [1], deps), { disabled: true });
  assert.equal(calls.length, 0);
  delete deps.settings.cc_send_images;
  assert.deepEqual((await autoSendImages(1, auth, [1], deps) as { sent: number[] }).sent, [1]);
});

test('sendImagesForCards groups by reservation: one comment each', async () => {
  install();
  const cards = [card(1, CODE_A, [1], 7), card(2, CODE_B, [2], 8)];
  await sendImagesForCards(1, auth, [1, 2], {}, memDeps(cards));
  assert.equal(comments().length, 2);
});

// ---- backfill ----

function bfDeps(opts: { photos: UnlinkedPhoto[]; orderCards: OrderCard[]; cards: ImageCard[] }) {
  const base = memDeps(opts.cards);
  const links: [number, number][] = [];
  const sleeps: number[] = [];
  const deps: BackfillDeps = {
    ...base,
    listUnlinkedPhotos: async () => opts.photos,
    listOrderCards: async () => opts.orderCards,
    linkPhoto: async (a, c) => { links.push([a, c]); const k = opts.cards.find(x => x.id === c); if (k) k.photos.push(photo(a)); },
    listBackfillCards: async () => opts.cards.filter(c => !c.ccImagesSentAt),
    sleep: async ms => { sleeps.push(ms); },
  };
  base.settings.cc_email = 'a@b.c';
  base.settings.cc_password = 'pw';
  return { deps, links, sleeps };
}
const up = (attachmentId: number, o: Partial<UnlinkedPhoto> = {}): UnlinkedPhoto =>
  ({ attachmentId, orderId: 1, kind: 'gift_card', ocrGiftCardId: null, candidates: [], texts: [], ...o });

test('planLinks: via PhotoOcr.giftCardId (same order only) and via candidates', () => {
  const cards: OrderCard[] = [{ id: 1, orderId: 1, cardNumber: CODE_A }, { id: 2, orderId: 2, cardNumber: CODE_B }];
  const plan = planLinks([
    up(10, { ocrGiftCardId: 1 }),
    up(11, { candidates: ['4111 2222 3333 1234'] }),
    up(12, { ocrGiftCardId: 2 }),           // card is on another order: falls through, no candidates -> ambiguous
    up(13, { texts: ['PIN', CODE_A.slice(0, 8), CODE_A.slice(8)] }),
  ], cards);
  assert.deepEqual(plan.links, [
    { attachmentId: 10, cardId: 1 }, { attachmentId: 11, cardId: 1 }, { attachmentId: 13, cardId: 1 },
  ]);
  assert.equal(plan.ambiguous, 1);
});

test('planLinks never links receipt or unknown photos, and skips ambiguous matches', () => {
  const cards: OrderCard[] = [{ id: 1, orderId: 1, cardNumber: CODE_A }, { id: 2, orderId: 1, cardNumber: CODE_A }];
  const plan = planLinks([
    up(20, { kind: 'receipt', ocrGiftCardId: 1, candidates: [CODE_A] }),
    up(21, { kind: 'unknown', candidates: [CODE_A] }),
    up(22, { kind: null, candidates: [CODE_A] }),
    up(23, { candidates: [CODE_A] }), // matches both cards
  ], cards);
  assert.deepEqual(plan.links, []);
  assert.equal(plan.ambiguous, 1);
});

test('backfill: dryRun returns counts and makes no fetch calls or writes', async () => {
  install();
  const cards = [card(1, CODE_A, []), card(2, CODE_B, [5]), card(3, '9000000000009999', [])];
  const { deps, links } = bfDeps({ photos: [up(10, { ocrGiftCardId: 1 })], orderCards: [{ id: 1, orderId: 1, cardNumber: CODE_A }], cards });
  const r = await backfillCardImages(1, { dryRun: true }, deps);
  assert.equal(calls.length, 0);
  assert.equal(links.length, 0);
  assert.deepEqual([r.reservations, r.cards, r.photos, r.noPhoto, r.ambiguous, r.linked], [1, 2, 2, 1, 0, 1]);
  assert.ok(!JSON.stringify(r).includes(CODE_A));
});

test('backfill: links, sends one comment per reservation, and a second run sends nothing', async () => {
  install();
  const cards = [card(1, CODE_A, [], 7), card(2, CODE_B, [5], 7)];
  const { deps, links } = bfDeps({ photos: [up(10, { ocrGiftCardId: 1 })], orderCards: [{ id: 1, orderId: 1, cardNumber: CODE_A }], cards });
  const r = await backfillCardImages(1, {}, deps);
  assert.deepEqual(links, [[10, 1]]);
  assert.equal(r.sentCards, 2);
  assert.equal(comments().length, 1);
  calls = [];
  const r2 = await backfillCardImages(1, {}, deps);
  assert.equal(calls.length, 0);
  assert.equal(r2.sentCards, 0);
});

test('backfill: per-run cap and 2s throttle; the rest go next run', async () => {
  install();
  const n = BACKFILL_MAX_RESERVATIONS + 3;
  const cards = Array.from({ length: n }, (_, i) => card(i + 1, `600000000000${String(1000 + i)}`, [i + 1], 100 + i));
  const { deps, sleeps } = bfDeps({ photos: [], orderCards: [], cards });
  const r = await backfillCardImages(1, {}, deps);
  assert.equal(comments().length, BACKFILL_MAX_RESERVATIONS);
  assert.equal(r.remainingReservations, 3);
  assert.equal(sleeps.length, BACKFILL_MAX_RESERVATIONS - 1);
  assert.ok(sleeps.every(s => s === 2000));
  const r2 = await backfillCardImages(1, {}, deps);
  assert.equal(r2.sentCards, 3);
});

test('backfill: one failing reservation does not stamp and does not stop the rest', async () => {
  install();
  const cards = [card(1, CODE_A, [1], 7), card(2, CODE_B, [2], 8)];
  const { deps } = bfDeps({ photos: [], orderCards: [], cards });
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) =>
    /Reservations\/7\/Comments$/.test(String(input)) ? json({}, 500) : origFetch(input as string, init)) as typeof fetch;
  const r = await backfillCardImages(1, {}, deps);
  assert.equal(r.sentCards, 1);
  assert.equal(r.failedCards, 1);
  assert.equal(cards[0].ccImagesSentAt, null);
  assert.ok(cards[1].ccImagesSentAt);
});
