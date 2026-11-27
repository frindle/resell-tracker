import test from 'node:test';
import assert from 'node:assert/strict';
import { planTitleSave } from './orderTitleEdit.ts';

test('an edited title is written and protected', () => {
  const p = planTitleSave({ incoming: 'My Widget', edited: true, stored: 'Linked Widget', editedFields: ['cardId'] });
  assert.deepEqual(p, { write: true, value: 'My Widget', editedFields: ['cardId', 'itemDescription'] });
});

test('a save that did not touch the title leaves the stored one alone', () => {
  const p = planTitleSave({ incoming: 'Old Copy', edited: false, stored: 'Linked Widget', editedFields: [] });
  assert.equal(p.write, false);
  assert.deepEqual(p.editedFields, []);
});

test('clearing the title hands it back to the links', () => {
  const p = planTitleSave({ incoming: '  ', edited: true, stored: 'My Widget', editedFields: ['itemDescription', 'cardId'] });
  assert.deepEqual(p, { write: true, value: null, editedFields: ['cardId'] });
});

test('older client without the flag: a changed title counts as an edit', () => {
  const p = planTitleSave({ incoming: 'New', edited: undefined, stored: 'Old', editedFields: [] });
  assert.deepEqual(p, { write: true, value: 'New', editedFields: ['itemDescription'] });
});

test('older client without the flag: an unchanged title is not marked', () => {
  const p = planTitleSave({ incoming: 'Same', edited: undefined, stored: 'Same', editedFields: [] });
  assert.deepEqual(p, { write: true, value: 'Same', editedFields: [] });
});

test('an already protected title stays protected when re-saved as edited', () => {
  const p = planTitleSave({ incoming: 'Mine', edited: true, stored: 'Mine', editedFields: ['itemDescription'] });
  assert.deepEqual(p.editedFields, ['itemDescription']);
});
