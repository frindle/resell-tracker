import test from 'node:test';
import assert from 'node:assert/strict';
import { isImageInput, onlyNonImageFiles } from './buildInputs.ts';

test('code, config and dependency files are image inputs', () => {
  for (const p of ['lib/gapFill.ts', 'app/page.tsx', 'prisma/schema.prisma', 'package.json', 'package-lock.json',
    'Dockerfile', 'Dockerfile.all-in-one', 'docker-compose.yml', 'next.config.ts', 'icon.png', 'scripts/x.ts']) {
    assert.equal(isImageInput(p), true, p);
  }
});

test('docs, tests, CI and the worker are not', () => {
  for (const p of ['README.md', 'AGENTS.md', 'lib/gapFill.test.ts', 'app/api/x/route.test.ts', '.github/workflows/ci.yml',
    'workers/order-inbox/src/index.js', 'workers/order-inbox/src/handlers.test.js', 'update.sh', 'prebuild.sh', 'tests/update_sh_test.sh', '.gitignore']) {
    assert.equal(isImageInput(p), false, p);
  }
});

test('files in runtime directories ship even when they look like docs or tests', () => {
  for (const p of ['public/notes.md', 'docker/README.md', 'sidecar/src/a.test.js', 'giftcard-ocr/README.md', 'prisma/migrations/1/migration.sql']) {
    assert.equal(isImageInput(p), true, p);
  }
});

test('a compare listing counts as "no update" only when every file is outside the image', () => {
  assert.equal(onlyNonImageFiles([{ filename: 'README.md' }, { filename: 'lib/a.test.ts' }]), true);
  assert.equal(onlyNonImageFiles([{ filename: 'README.md' }, { filename: 'lib/a.ts' }]), false);
});

test('an empty, missing or full (300) listing is not trusted', () => {
  assert.equal(onlyNonImageFiles(undefined), false);
  assert.equal(onlyNonImageFiles([]), false);
  assert.equal(onlyNonImageFiles(Array.from({ length: 300 }, () => ({ filename: 'README.md' }))), false);
  assert.equal(onlyNonImageFiles([{}]), false);
});
