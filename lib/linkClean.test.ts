import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanUrl, extractDestParam, hostOf, isHttpUrl, resolveLanded, resolveOffline } from './linkClean.ts';

test('amazon links reduce to /dp/ASIN', () => {
  assert.equal(cleanUrl('https://www.amazon.com/Some-Title/dp/B0ABCDEFGH/ref=sr_1_1?tag=x&linkCode=ll1'), 'https://www.amazon.com/dp/B0ABCDEFGH');
});

test('walmart, bestbuy, target, dell keep only the path', () => {
  assert.equal(cleanUrl('https://walmart.com/ip/tv/123?wmlspartner=a&veh=aff'), 'https://www.walmart.com/ip/tv/123');
  assert.equal(cleanUrl('https://www.bestbuy.com/site/x/1.p?skuId=1&ref=2'), 'https://www.bestbuy.com/site/x/1.p');
  assert.equal(cleanUrl('https://www.target.com/p/x/-/A-1?afid=1'), 'https://www.target.com/p/x/-/A-1');
  assert.equal(cleanUrl('https://deals.dell.com/en-us/p?x=1'), 'https://www.dell.com/en-us/p');
});

test('other sites lose tracking params but keep the rest', () => {
  assert.equal(cleanUrl('https://shop.example.com/p?id=7&utm_source=a&UTM_Medium=b&ranMID=1&color=red'), 'https://shop.example.com/p?id=7&color=red');
});

test('garbage is returned as is', () => {
  assert.equal(cleanUrl('not a url'), 'not a url');
});

test('redirector params carry the destination', () => {
  const u = new URL('https://ftc.example/go?url=' + encodeURIComponent('https://www.walmart.com/ip/1?x=1'));
  assert.equal(extractDestParam(u), 'https://www.walmart.com/ip/1?x=1');
  assert.equal(extractDestParam(new URL('https://a.example/?url=javascript:alert(1)')), null);
});

test('resolveOffline: retail domain, redirector param, or needs a hop', () => {
  assert.equal(resolveOffline('https://www.bestbuy.com/site/x/1.p?ref=a'), 'https://www.bestbuy.com/site/x/1.p');
  assert.equal(resolveOffline('https://ftc.example/go?url=' + encodeURIComponent('https://www.amazon.com/x/dp/B0ABCDEFGH?tag=z')), 'https://www.amazon.com/dp/B0ABCDEFGH');
  assert.equal(resolveOffline('https://short.example/abc'), null);
  assert.equal(resolveOffline('nope'), null);
});

test('resolveLanded handles retail landing, destination param and plain pages', () => {
  assert.equal(resolveLanded('https://www.target.com/p/x/-/A-1?afid=1'), 'https://www.target.com/p/x/-/A-1');
  assert.equal(resolveLanded('https://trk.example/r?dest=' + encodeURIComponent('https://www.walmart.com/ip/9?a=1')), 'https://www.walmart.com/ip/9');
  assert.equal(resolveLanded('https://shop.example/p?utm_id=1&a=2'), 'https://shop.example/p?a=2');
});

test('hostOf and isHttpUrl', () => {
  assert.equal(hostOf('https://www.Best.com/x'), 'best.com');
  assert.equal(hostOf('x'), null);
  assert.equal(isHttpUrl('javascript:alert(1)'), false);
  assert.equal(isHttpUrl('http://a.example'), true);
});
