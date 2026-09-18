import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUpdateProxy, proxyBypassed } from '../lib/update-proxy.ts';
import { parseRegistryReference } from '../lib/registry-reference.ts';

void test('validates app-only update proxy settings', () => {
  assert.deepEqual(
    normalizeUpdateProxy({
      enabled: true,
      url: 'http://user:pass@proxy.example.com:7890/',
      noProxy: ' localhost,.internal.example ',
    }),
    {
      enabled: true,
      url: 'http://user:pass@proxy.example.com:7890',
      noProxy: 'localhost,.internal.example',
    },
  );
  assert.throws(() => normalizeUpdateProxy({ enabled: true, url: '' }));
  assert.throws(() => normalizeUpdateProxy({ enabled: true, url: 'socks5://localhost:1080' }));
});

void test('matches proxy bypass hosts and suffixes', () => {
  assert.equal(proxyBypassed('https://registry.example.com/v2/', '.example.com'), true);
  assert.equal(proxyBypassed('https://example.com/v2/', '.example.com'), false);
  assert.equal(proxyBypassed('https://localhost:5000/v2/', 'localhost:5000'), true);
  assert.equal(proxyBypassed('https://registry-1.docker.io/v2/', 'localhost'), false);
});

void test('parses Docker Hub and private registry references', () => {
  assert.deepEqual(parseRegistryReference('nginx:latest'), {
    registry: 'registry-1.docker.io',
    repository: 'library/nginx',
    tag: 'latest',
    protocol: 'https:',
  });
  assert.deepEqual(parseRegistryReference('projectdown/docker-manager'), {
    registry: 'registry-1.docker.io',
    repository: 'projectdown/docker-manager',
    tag: 'latest',
    protocol: 'https:',
  });
  assert.deepEqual(parseRegistryReference('localhost:5000/team/app:v2'), {
    registry: 'localhost:5000',
    repository: 'team/app',
    tag: 'v2',
    protocol: 'http:',
  });
});
