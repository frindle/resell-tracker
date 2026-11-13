import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dragHasFiles, nextDragDepth, isPhotoFile, planDroppedPhotos, ocrStillRunning } from './fileDrop.ts';

test('only desktop file drags count', () => {
  assert.equal(dragHasFiles(['Files']), true);
  assert.equal(dragHasFiles(['text/plain', 'Files']), true);
  assert.equal(dragHasFiles(['text/uri-list', 'text/html']), false);
  assert.equal(dragHasFiles([]), false);
  assert.equal(dragHasFiles(undefined), false);
});

test('drag depth survives crossing child elements and resets on drop', () => {
  let d = 0;
  for (const ev of ['enter', 'enter', 'leave', 'enter', 'leave'] as const) d = nextDragDepth(d, ev);
  assert.equal(d, 1);
  assert.equal(nextDragDepth(d, 'drop'), 0);
  assert.equal(nextDragDepth(0, 'leave'), 0);
});

test('photo files by type, or by name when the type is empty', () => {
  assert.equal(isPhotoFile({ type: 'image/jpeg', name: 'a.jpg' }), true);
  assert.equal(isPhotoFile({ type: '', name: 'IMG_0001.HEIC' }), true);
  assert.equal(isPhotoFile({ type: 'application/pdf', name: 'r.pdf' }), false);
  assert.equal(isPhotoFile({ type: '', name: 'notes.txt' }), false);
});

test('new and still-unsorted duplicate photos are added; photos on other orders are not', () => {
  const plan = planDroppedPhotos({
    created: 2, duplicates: 2, rejected: [],
    attachments: [{ id: 10 }, { id: 11 }],
    existing: [{ id: 5, orderId: null }, { id: 6, orderId: 42 }],
  });
  assert.deepEqual(plan.addIds, [10, 11, 5]);
  assert.match(plan.note ?? '', /1 photo is already on another order/);
});

test('notes for unreadable files and non-photos; none when all is well', () => {
  assert.equal(planDroppedPhotos({ attachments: [{ id: 1 }] }).note, null);
  const plan = planDroppedPhotos({ attachments: [], rejected: [{ name: 'x.jpg', error: 'bad' }] }, 2);
  assert.deepEqual(plan.addIds, []);
  assert.match(plan.note ?? '', /1 file could not be read/);
  assert.match(plan.note ?? '', /2 files are not photos/);
});

test('a duplicate listed twice is added once', () => {
  const plan = planDroppedPhotos({ attachments: [{ id: 3 }], existing: [{ id: 3, orderId: null }, { id: 3, orderId: null }] });
  assert.deepEqual(plan.addIds, [3]);
});

test('OCR still running only while pending or running', () => {
  assert.equal(ocrStillRunning('pending'), true);
  assert.equal(ocrStillRunning('running'), true);
  for (const s of ['done', 'stopped', 'error', 'unread', undefined, null]) assert.equal(ocrStillRunning(s), false);
});
