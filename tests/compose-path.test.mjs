import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateComposeDirectory } from '../lib/compose-path.ts';

void test('allows nested directories below compose root', () => {
  assert.equal(validateComposeDirectory('media/jellyfin'), 'media/jellyfin');
  assert.equal(validateComposeDirectory('家庭服务/相册_1'), '家庭服务/相册_1');
});

void test('rejects root, absolute and traversal paths', () => {
  for (const path of ['', '/', '/etc', '../etc', 'apps/../etc', 'apps//nginx', '.']) {
    assert.throws(() => validateComposeDirectory(path), path);
  }
});
