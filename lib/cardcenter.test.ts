import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// Plain node cannot resolve the `@/` alias used by lib/cardcenter.ts, and no
// other lib test loads an `@/`-importing module. Register a resolve hook that
// maps `@/lib/db` and `@/lib/apiCallLog` to tiny in-memory stubs.
const hooks = `
const stubs = {
  '@/lib/db': 'export const getSetting = async () => null; export const upsertSetting = async () => {};',
  '@/lib/apiCallLog': 'export const loggedFetch = (_ctx, url, init) => globalThis.fetch(url, init);',
};
export async function resolve(specifier, context, next) {
  if (stubs[specifier]) {
    return { url: 'data:text/javascript,' + encodeURIComponent(stubs[specifier]), shortCircuit: true };
  }
  return next(specifier, context);
}
`;
register('data:text/javascript,' + encodeURIComponent(hooks));

const { ccApiFetch } = await import('./cardcenter.ts');

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
type Handler = (call: Call, n: number) => Response | undefined;

const realFetch = globalThis.fetch;

function loginPage(html?: string): Response {
  const body = html ?? '<html><script>window.token = {"requestToken":"tok-1","formFieldName":"__RequestVerificationToken"};</script></html>';
  const h = new Headers({ 'content-type': 'text/html' });
  h.append('set-cookie', 'AF=anti1; path=/; httponly');
  return new Response(body, { status: 200, headers: h });
}

function json(body: unknown, status = 200, cookie?: string): Response {
  const h = new Headers({ 'content-type': 'application/json' });
  if (cookie) h.append('set-cookie', cookie);
  return new Response(JSON.stringify(body), { status, headers: h });
}

function install(postLogin: Handler, page?: string) {
  const calls: Call[] = [];
  let posts = 0;
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    const call: Call = {
      url,
      method: (init.method ?? 'GET').toUpperCase(),
      headers: { ...(init.headers as Record<string, string> | undefined) },
      body: init.body as string | undefined,
    };
    calls.push(call);
    if (url.endsWith('/Account/Login') && call.method === 'GET') return loginPage(page);
    if (url.endsWith('/Api/Account/Login') && call.method === 'POST') {
      return postLogin(call, ++posts) ?? json({}, 200, 'SESS=sess1; path=/');
    }
    if (url.endsWith('/Api/AntiforgeryTokens')) return json({ requestToken: 'tok-2' });
    return json({ ok: true });
  }) as typeof fetch;
  return calls;
}

const loginPosts = (calls: Call[]) => calls.filter(c => c.url.endsWith('/Api/Account/Login') && c.method === 'POST');
const run = () => ccApiFetch(null, 'a@b.c', 'pw', '/Api/Ping');

test.afterEach(() => { globalThis.fetch = realFetch; });

test('login posts JSON to /Api/Account/Login with token and antiforgery cookie', async () => {
  const calls = install(() => undefined, '<input name="__RequestVerificationToken" type="hidden" value="legacy"><script>window.token = {"requestToken":"tok-1"};</script>');
  await run();
  const posts = loginPosts(calls);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].headers['RequestVerificationToken'], 'tok-1');
  assert.deepEqual(JSON.parse(posts[0].body!), { email: 'a@b.c', password: 'pw' });
  assert.match(posts[0].headers['Cookie'], /AF=anti1/);
  // Both cookies reach the follow-up API call (cookieStr contains both).
  const last = calls[calls.length - 1];
  assert.match(last.headers['Cookie'], /AF=anti1/);
  assert.match(last.headers['Cookie'], /SESS=sess1/);
});

test('login retries once with a fresh token after 400 Antiforgery', async () => {
  const calls = install((_c, n) => (n === 1 ? json({ reason: 'Antiforgery' }, 400) : undefined));
  await run();
  const posts = loginPosts(calls);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].headers['RequestVerificationToken'], 'tok-1');
  assert.equal(posts[1].headers['RequestVerificationToken'], 'tok-2');
});

test('login rejects with two-factor when body has twoFactor', async () => {
  install(() => json({ twoFactor: true }));
  await assert.rejects(run(), (e: Error) => /two-factor/.test(e.message));
});

test('login rejects when the page has no window.token', async () => {
  install(() => undefined, '<html><body>spa</body></html>');
  await assert.rejects(run(), (e: Error) => /window\.token not found/.test(e.message));
});

test('failed login error never contains the password', async () => {
  install(() => json({ title: 'Bad credentials' }, 401));
  await assert.rejects(run(), (e: Error) => {
    assert.match(e.message, /CardCenter login failed \(401\)/);
    assert.ok(!e.message.includes('pw'));
    return true;
  });
});
