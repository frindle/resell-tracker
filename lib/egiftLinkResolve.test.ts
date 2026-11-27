import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTrackedDeliveryLink } from './egiftLinkResolve.ts';

const T1 = 'https://link.memberedelivery.com/ls/click?upn=SYNTHETIC1';
const T2 = 'https://link.memberedelivery.com/ls/click?upn=SYNTHETIC2';
const DEST = 'https://www.memberedelivery.com/?login=SYNTHETICTOKEN';

type Route = { status: number; location?: string; body?: string } | Error;
function fakeFetch(routes: Record<string, Route>) {
  const calls: { url: string; redirect?: string }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, redirect: init?.redirect });
    const r = routes[url];
    if (!r) return new Response('nope', { status: 404 });
    if (r instanceof Error) throw r;
    return new Response(r.body ?? null, { status: r.status, headers: r.location ? { location: r.location } : {} });
  }) as typeof fetch;
  return { fn, calls };
}

test('a 302 to the delivery link resolves, with redirects handled by hand', async () => {
  const f = fakeFetch({ [T1]: { status: 302, location: DEST } });
  assert.equal(await resolveTrackedDeliveryLink([T1], f.fn), DEST);
  assert.deepEqual(f.calls.map(c => c.redirect), ['manual']);
});

test('follows tracking-host hops, including a relative location', async () => {
  const hop = 'https://u1.ct.sendgrid.net/wf/click?upn=HOP';
  const f = fakeFetch({ [T1]: { status: 301, location: hop }, [hop]: { status: 302, location: DEST } });
  assert.equal(await resolveTrackedDeliveryLink([T1], f.fn), DEST);
  const rel = fakeFetch({ [T1]: { status: 302, location: '/ls/click?upn=NEXT' }, ['https://link.memberedelivery.com/ls/click?upn=NEXT']: { status: 302, location: DEST } });
  assert.equal(await resolveTrackedDeliveryLink([T1], rel.fn), DEST);
});

test('a redirect anywhere else stops, and the next link is tried', async () => {
  const f = fakeFetch({ [T1]: { status: 302, location: 'https://evil.example/?login=X' }, [T2]: { status: 302, location: DEST } });
  assert.equal(await resolveTrackedDeliveryLink([T1, T2], f.fn), DEST);
  assert.equal(f.calls.some(c => new URL(c.url).hostname === 'evil.example'), false);
});

test('a redirect to the bare delivery host resolves to the www link', async () => {
  const f = fakeFetch({ [T1]: { status: 302, location: 'https://memberedelivery.com/?login=SYNTHETICTOKEN' } });
  assert.equal(await resolveTrackedDeliveryLink([T1], f.fn), DEST);
});

test('a delivery-site page without a login, a 404, an error and a loop all give null', async () => {
  assert.equal(await resolveTrackedDeliveryLink([T1], fakeFetch({ [T1]: { status: 302, location: 'https://www.memberedelivery.com/' } }).fn), null);
  assert.equal(await resolveTrackedDeliveryLink([T1], fakeFetch({}).fn), null);
  assert.equal(await resolveTrackedDeliveryLink([T1], fakeFetch({ [T1]: new Error('boom') }).fn), null);
  const loop = fakeFetch({ [T1]: { status: 302, location: T1 } });
  assert.equal(await resolveTrackedDeliveryLink([T1], loop.fn, { maxHops: 4 }), null);
  assert.equal(loop.calls.length, 4);
});

test('a 200 page that carries the link (meta refresh) resolves', async () => {
  const f = fakeFetch({ [T1]: { status: 200, body: `<meta http-equiv="refresh" content="0;url=${DEST}">` } });
  assert.equal(await resolveTrackedDeliveryLink([T1], f.fn), DEST);
});

test('never fetches a non-tracking or http start url, and caps the links tried', async () => {
  const f = fakeFetch({});
  assert.equal(await resolveTrackedDeliveryLink(['https://evil.example/ls/click?upn=x', 'http://link.memberedelivery.com/ls/click?upn=x'], f.fn), null);
  assert.equal(f.calls.length, 0);
  const many = ['A', 'B', 'C', 'D', 'E'].map(x => `https://link.memberedelivery.com/ls/click?upn=${x}`);
  const g = fakeFetch({});
  await resolveTrackedDeliveryLink(many, g.fn);
  assert.equal(g.calls.length, 3);
});
