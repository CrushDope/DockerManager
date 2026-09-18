import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMirrorSources } from '../lib/mirror-sources.ts';

test('normalizes editable mirror sources and preserves enabled state', () => {
  assert.deepEqual(
    normalizeMirrorSources([
      { id: 'primary', url: 'https://mirror.example.com/', enabled: true },
      { id: 'backup', url: 'http://192.0.2.8:5000', enabled: false },
    ]),
    [
      { id: 'primary', url: 'https://mirror.example.com', enabled: true },
      { id: 'backup', url: 'http://192.0.2.8:5000', enabled: false },
    ],
  );
});

test('rejects duplicate, credentialed, and unsupported mirror URLs', () => {
  assert.throws(() =>
    normalizeMirrorSources([
      { url: 'https://mirror.example.com', enabled: true },
      { url: 'https://mirror.example.com/', enabled: false },
    ]),
  );
  assert.throws(() =>
    normalizeMirrorSources([{ url: 'https://user:secret@mirror.example.com', enabled: true }]),
  );
  assert.throws(() =>
    normalizeMirrorSources([{ url: 'ftp://mirror.example.com', enabled: true }]),
  );
});
