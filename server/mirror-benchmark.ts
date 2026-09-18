import { performance } from 'node:perf_hooks';
import { config } from './config.js';
import { manifestDigestFrom, parseRegistryReference } from './registry.js';
import {
  type MirrorBenchmarkRecord,
  median,
  orderMirrorSourcesByBenchmark,
} from '../lib/mirror-benchmark.js';
import {
  MirrorValidationError,
  normalizeMirrorSources,
} from '../lib/mirror-sources.js';

async function probe(image: string, sourceId: string, url: string) {
  const samplesMs: number[] = [];
  let digest = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const started = performance.now();
    digest = await manifestDigestFrom(image, url, config.mirrorBenchmarkTimeoutMs);
    samplesMs.push(Math.max(1, Math.round(performance.now() - started)));
  }
  return {
    sourceId,
    url,
    status: 'ok' as const,
    latencyMs: median(samplesMs),
    samplesMs,
    digest,
  };
}

export async function benchmarkMirrors(input: unknown, imageInput: unknown) {
  const sources = normalizeMirrorSources(input);
  const enabled = sources.filter((source) => source.enabled);
  if (!enabled.length) {
    throw new MirrorValidationError('请至少启用一个镜像源后再测速', 400, 'MIRROR_BENCHMARK_EMPTY');
  }
  const image = typeof imageInput === 'string' ? imageInput.trim() : '';
  if (!image) {
    throw new MirrorValidationError('请输入用于测速的 Docker Hub 镜像', 400, 'MIRROR_BENCHMARK_IMAGE_REQUIRED');
  }
  let reference: ReturnType<typeof parseRegistryReference>;
  try {
    reference = parseRegistryReference(image);
  } catch (error) {
    throw new MirrorValidationError(
      error instanceof Error ? error.message : '测速镜像名称无效',
      400,
      'MIRROR_BENCHMARK_IMAGE_INVALID',
    );
  }
  if (reference.registry !== 'registry-1.docker.io') {
    throw new MirrorValidationError(
      'Docker registry-mirrors 仅用于 Docker Hub，请选择 Docker Hub 镜像测速',
      400,
      'MIRROR_BENCHMARK_IMAGE_UNSUPPORTED',
    );
  }

  const originUrl = `${reference.protocol}//${reference.registry}`;
  const referencePromise = manifestDigestFrom(
    image,
    originUrl,
    config.mirrorBenchmarkTimeoutMs,
  ).then(
    (digest) => ({ digest, error: null as string | null }),
    (error) => ({
      digest: null,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  const recordsPromise = Promise.all(
    enabled.map(async (source): Promise<MirrorBenchmarkRecord> => {
      try {
        return await probe(image, source.id, source.url);
      } catch (error) {
        return {
          sourceId: source.id,
          url: source.url,
          status: 'error',
          latencyMs: null,
          samplesMs: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  const [referenceResult, probed] = await Promise.all([referencePromise, recordsPromise]);
  const results = probed.map<MirrorBenchmarkRecord>((record) =>
    record.status === 'ok' && referenceResult.digest && record.digest !== referenceResult.digest
      ? {
          ...record,
          status: 'mismatch',
          error: '返回摘要与 Docker Hub 官方仓库不一致',
        }
      : record,
  );
  const orderedSources = orderMirrorSourcesByBenchmark(sources, results);
  const recommended = results
    .filter((record) => record.status === 'ok')
    .sort((left, right) => (left.latencyMs || Infinity) - (right.latencyMs || Infinity))[0];

  return {
    image,
    testedAt: new Date().toISOString(),
    referenceDigest: referenceResult.digest,
    referenceError: referenceResult.error,
    recommendedSourceId: recommended?.sourceId || null,
    results,
    orderedSources,
  };
}
