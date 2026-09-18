import type { MirrorSource } from './mirror-sources.js';

export type MirrorBenchmarkStatus = 'ok' | 'mismatch' | 'error';

export type MirrorBenchmarkRecord = {
  sourceId: string;
  url: string;
  status: MirrorBenchmarkStatus;
  latencyMs: number | null;
  samplesMs: number[];
  digest?: string;
  error?: string;
};

function rank(status: MirrorBenchmarkStatus) {
  if (status === 'ok') return 0;
  if (status === 'mismatch') return 1;
  return 2;
}

export function median(values: number[]) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : Math.round((ordered[middle - 1] + ordered[middle]) / 2);
}

export function orderMirrorSourcesByBenchmark(
  sources: MirrorSource[],
  results: MirrorBenchmarkRecord[],
) {
  const records = new Map(results.map((result) => [result.sourceId, result]));
  const originalOrder = new Map(sources.map((source, index) => [source.id, index]));
  const enabled = sources.filter((source) => source.enabled).sort((left, right) => {
    const a = records.get(left.id);
    const b = records.get(right.id);
    if (!a && !b) return (originalOrder.get(left.id) || 0) - (originalOrder.get(right.id) || 0);
    if (!a) return 1;
    if (!b) return -1;
    const statusDifference = rank(a.status) - rank(b.status);
    if (statusDifference) return statusDifference;
    const latencyDifference = (a.latencyMs ?? Number.MAX_SAFE_INTEGER) - (b.latencyMs ?? Number.MAX_SAFE_INTEGER);
    return latencyDifference || (originalOrder.get(left.id) || 0) - (originalOrder.get(right.id) || 0);
  });
  return [...enabled, ...sources.filter((source) => !source.enabled)];
}
