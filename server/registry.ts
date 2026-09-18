import { createHash } from 'node:crypto';
import { fetch, type Dispatcher, type Response } from 'undici';
import { config } from './config.js';
import { proxyDispatcher } from './update-proxy.js';
import {
  parseRegistryReference as parseReference,
  RegistryReferenceError,
  type RegistryReference,
} from '../lib/registry-reference.js';

const manifestAccept = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

export class RegistryError extends Error {
  readonly statusCode = 502;
}

export function parseRegistryReference(image: string): RegistryReference {
  try {
    return parseReference(image);
  } catch (error) {
    if (error instanceof RegistryReferenceError) throw new RegistryError(error.message);
    throw error;
  }
}

async function request(
  url: string,
  init: { method?: string; headers?: Record<string, string> },
  timeoutMs = config.updatePullTimeoutMs,
) {
  let dispatcher: Dispatcher | undefined;
  try {
    dispatcher = await proxyDispatcher(url);
    return await fetch(url, {
      ...init,
      dispatcher,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RegistryError(`镜像仓库请求失败：${message}`);
  }
}

function bearerParameters(header: string) {
  if (!/^Bearer\s/i.test(header)) return null;
  const values = new Map<string, string>();
  for (const match of header.matchAll(/([a-zA-Z]+)="([^"]*)"/g)) values.set(match[1], match[2]);
  return values;
}

async function registryToken(challenge: string, reference: RegistryReference, timeoutMs: number) {
  const parameters = bearerParameters(challenge);
  if (!parameters?.get('realm')) {
    throw new RegistryError('镜像仓库需要当前版本不支持的认证方式');
  }
  const url = new URL(parameters.get('realm')!);
  if (parameters.get('service')) url.searchParams.set('service', parameters.get('service')!);
  url.searchParams.set(
    'scope',
    parameters.get('scope') || `repository:${reference.repository}:pull`,
  );
  const response = await request(url.toString(), { headers: { Accept: 'application/json' } }, timeoutMs);
  if (!response.ok) throw new RegistryError(`镜像仓库认证失败（HTTP ${response.status}）`);
  const value = (await response.json()) as { token?: string; access_token?: string };
  const token = value.token || value.access_token;
  if (!token) throw new RegistryError('镜像仓库认证响应中没有令牌');
  return token;
}

async function manifestRequest(url: string, authorization: string | undefined, timeoutMs: number): Promise<Response> {
  return request(url, {
    method: 'HEAD',
    headers: {
      Accept: manifestAccept,
      ...(authorization ? { Authorization: authorization } : {}),
    },
  }, timeoutMs);
}

async function tryManifestDigest(
  reference: RegistryReference,
  registryUrl: string,
  timeoutMs = config.updatePullTimeoutMs,
): Promise<string> {
  const base = registryUrl.replace(/\/$/, '');
  const url = `${base}/v2/${reference.repository}/manifests/${encodeURIComponent(reference.tag)}`;
  let authorization: string | undefined;
  let response = await manifestRequest(url, undefined, timeoutMs);
  if (response.status === 401) {
    const challenge = response.headers.get('www-authenticate') || '';
    await response.body?.cancel();
    const token = await registryToken(challenge, reference, timeoutMs);
    authorization = `Bearer ${token}`;
    response = await manifestRequest(url, authorization, timeoutMs);
  }
  if (!response.ok && response.status !== 405) {
    await response.body?.cancel();
    throw new RegistryError(`镜像仓库返回 HTTP ${response.status}`);
  }
  const headerDigest = response.headers.get('docker-content-digest');
  await response.body?.cancel();
  if (headerDigest) return headerDigest;

  const fallback = await request(url, {
    method: 'GET',
    headers: {
      Accept: manifestAccept,
      ...(authorization ? { Authorization: authorization } : {}),
    },
  }, timeoutMs);
  if (!fallback.ok) throw new RegistryError(`无法读取镜像清单摘要`);
  const fallbackDigest = fallback.headers.get('docker-content-digest');
  if (fallbackDigest) {
    await fallback.body?.cancel();
    return fallbackDigest;
  }
  const bytes = Buffer.from(await fallback.arrayBuffer());
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export async function manifestDigestFrom(
  image: string,
  registryUrl: string,
  timeoutMs = config.updatePullTimeoutMs,
) {
  const reference = parseRegistryReference(image);
  return tryManifestDigest(reference, registryUrl, timeoutMs);
}

export async function remoteManifestDigest(image: string, mirrors: string[] = []) {
  const reference = parseRegistryReference(image);
  const registries = [...mirrors, `${reference.protocol}//${reference.registry}`];

  console.log(`[Registry] 开始检查镜像 ${image}，尝试 ${registries.length} 个源:`, registries);

  let lastError: Error | null = null;
  for (const registry of registries) {
    try {
      console.log(`[Registry] 正在尝试 ${registry}...`);
      const digest = await tryManifestDigest(reference, registry);
      console.log(`[Registry] ✓ ${registry} 成功，digest: ${digest}`);
      return digest;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.log(`[Registry] ✗ ${registry} 失败: ${lastError.message}`);
      continue;
    }
  }

  const errorMsg = `所有镜像源均无法访问：${lastError?.message || '未知错误'}。镜像：${image}`;
  console.error(`[Registry] ${errorMsg}`);
  throw new RegistryError(errorMsg);
}
