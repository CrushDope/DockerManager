import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePortMappings } from '../lib/docker-ports.ts';

void test('deduplicates IPv4 and IPv6 wildcard bindings', () => {
  assert.deepEqual(normalizePortMappings([
    { IP: '0.0.0.0', PrivatePort: 3000, PublicPort: 3102, Type: 'tcp' },
    { IP: '::', PrivatePort: 3000, PublicPort: 3102, Type: 'tcp' },
  ]), [{ hostIp: null, host: 3102, container: 3000, protocol: 'TCP' }]);
});

void test('preserves bindings on distinct explicit host addresses', () => {
  assert.equal(normalizePortMappings([
    { IP: '192.0.2.10', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' },
    { IP: '192.0.2.11', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' },
  ]).length, 2);
});
