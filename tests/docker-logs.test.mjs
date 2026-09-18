import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeDockerLogs } from '../lib/docker-logs.ts';

function frame(stream, content) {
  const payload = Buffer.from(content);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

void test('decodes multiplexed stdout and stderr with Docker timestamps', () => {
  const value = Buffer.concat([
    frame(1, '2026-09-18T01:02:03.123456789Z server ready\n'),
    frame(2, '2026-09-18T01:02:04.000000000Z connection failed\n'),
  ]);
  assert.deepEqual(decodeDockerLogs(value, false), [
    { timestamp: '2026-09-18T01:02:03.123456789Z', stream: 'stdout', message: 'server ready' },
    { timestamp: '2026-09-18T01:02:04.000000000Z', stream: 'stderr', message: 'connection failed' },
  ]);
});

void test('decodes TTY output and removes ANSI sequences', () => {
  const value = Buffer.from('\u001b[31m2026-09-18T01:02:03Z warning\u001b[0m\n');
  assert.deepEqual(decodeDockerLogs(value, true), [
    { timestamp: '2026-09-18T01:02:03Z', stream: 'console', message: 'warning' },
  ]);
});
