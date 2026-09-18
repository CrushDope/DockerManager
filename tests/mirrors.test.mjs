import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mirrorConfigurationMatches, normalizeMirrorSources } from '../lib/mirror-sources.ts';

void test('normalizes editable mirror sources and preserves enabled state', () => {
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

void test('rejects duplicate, credentialed, and unsupported mirror URLs', () => {
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

void test('accepts engine-managed extra mirrors while verifying managed sources', () => {
  const sources = normalizeMirrorSources([
    { url: 'https://mirror.example.com', enabled: true },
    { url: 'https://disabled.example.com', enabled: false },
  ]);
  assert.equal(
    mirrorConfigurationMatches(sources, [
      'https://engine-flag.example.com/',
      'https://mirror.example.com/',
    ]),
    true,
  );
  assert.equal(
    mirrorConfigurationMatches(sources, ['https://disabled.example.com/']),
    false,
  );
});
