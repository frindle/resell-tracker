import test from 'node:test';
import assert from 'node:assert/strict';
import { detectCarrier } from './carrierDetect.ts';

test('detectCarrier reads the number format', () => {
  assert.equal(detectCarrier('1Z999AA10123456784'), 'ups');
  assert.equal(detectCarrier('123456789012345'), 'fedex');
  assert.equal(detectCarrier('9400111899223197428490'), 'usps');
  assert.equal(detectCarrier('TBA123456789012'), 'amazon');
  assert.equal(detectCarrier(' 1z999aa10123456784 '), 'ups');
  assert.equal(detectCarrier('abc'), 'unknown');
  assert.equal(detectCarrier(''), 'unknown');
});

test('a carrier name captured with the package wins over the number', () => {
  assert.equal(detectCarrier('ZZ12345', 'Walmart Delivery'), 'walmart');
  assert.equal(detectCarrier('123456789012345', 'Amazon Logistics'), 'amazon');
  assert.equal(detectCarrier('ZZ12345', 'UPS'), 'ups');
  assert.equal(detectCarrier('1Z999AA10123456784', 'something else'), 'ups');
  assert.equal(detectCarrier('1Z999AA10123456784', null), 'ups');
});
