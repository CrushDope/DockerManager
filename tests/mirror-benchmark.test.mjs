import { test } from 'node:test';
import assert from 'node:assert/strict';
import { median, orderMirrorSourcesByBenchmark } from '../lib/mirror-benchmark.ts';

void test('uses the median latency and puts fast valid mirrors first', () => {
  assert.equal(median([90, 30, 60]), 60);
  assert.equal(median([80, 20]), 50);
  const sources = [
    { id: 'slow', url: 'https://slow.example.com', enabled: true },
    { id: 'off', url: 'https://off.example.com', enabled: false },
    { id: 'fast', url: 'https://fast.example.com', enabled: true },
    { id: 'stale', url: 'https://stale.example.com', enabled: true },
  ];
  const ordered = orderMirrorSourcesByBenchmark(sources, [
    { sourceId: 'slow', url: sources[0].url, status: 'ok', latencyMs: 300, samplesMs: [290, 310] },
    { sourceId: 'fast', url: sources[2].url, status: 'ok', latencyMs: 80, samplesMs: [70, 90] },
    { sourceId: 'stale', url: sources[3].url, status: 'mismatch', latencyMs: 20, samplesMs: [20, 20] },
  ]);
  assert.deepEqual(ordered.map((source) => source.id), ['fast', 'slow', 'stale', 'off']);
});
