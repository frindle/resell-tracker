import { test } from 'node:test';
import assert from 'node:assert/strict';

const REL = '/vnc/vnc.html?autoconnect=true&resize=scale';
let n = 0;

async function call(hostHeader: string | null, envPort?: string) {
  if (envPort === undefined) delete process.env.SIDECAR_FRONT_DOOR_PORT;
  else process.env.SIDECAR_FRONT_DOOR_PORT = envPort;
  const mod = await import(`./route.ts?bust=${++n}`);
  const headers: Record<string, string> = {};
  if (hostHeader !== null) headers.host = hostHeader;
  const res = await mod.GET(new Request('http://internal.invalid/api/sidecar/info', { headers }));
  return res.json();
}

test('no explicit port -> relative url', async () => {
  const j = await call('reselling.penndalton.com');
  assert.equal(j.novncUrl, REL);
  assert.equal(j.novncPath, REL);
  assert.equal(j.port, 5900);
});

test('port equals front door (8088) -> relative url', async () => {
  assert.equal((await call('192.168.1.5:8088')).novncUrl, REL);
});

test('other port :3000 -> absolute on 8088', async () => {
  const j = await call('myhost.lan:3000');
  assert.equal(j.novncUrl, `http://myhost.lan:8088${REL}`);
  assert.equal(j.novncPath, REL);
  assert.equal(j.port, 5900);
});

test('custom env front door port honored', async () => {
  assert.equal((await call('h.lan:9000', '9000')).novncUrl, REL);
  assert.equal((await call('h.lan:3000', '9000')).novncUrl, `http://h.lan:9000${REL}`);
});

test('bracketed IPv6 not mangled', async () => {
  assert.equal((await call('[::1]')).novncUrl, REL);
  assert.equal((await call('[::1]:8088')).novncUrl, REL);
  assert.equal((await call('[::1]:3000')).novncUrl, `http://[::1]:8088${REL}`);
  assert.equal((await call('[fe80::1]:3000')).novncUrl, `http://[fe80::1]:8088${REL}`);
});
