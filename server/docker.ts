import http, { type IncomingHttpHeaders } from 'node:http';
import { config } from './config.js';

export class DockerError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly response?: unknown,
    readonly code = 'DOCKER_API_ERROR',
  ) {
    super(message);
  }
}

type RequestOptions = {
  method?: string;
  body?: unknown;
  headers?: IncomingHttpHeaders;
  accept?: number[];
  timeoutMs?: number;
  raw?: boolean;
  onData?: (chunk: Buffer) => void;
};

export type ImagePullProgress = {
  status: string;
  id?: string;
  progress?: string;
  current?: number;
  total?: number;
};

export async function dockerRequest<T>(path: string, options: RequestOptions = {}) {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      callback();
    };
    const request = http.request(
      {
        socketPath: config.dockerSocket,
        path,
        method: options.method || 'GET',
        headers: {
          Accept: 'application/json',
          ...(payload
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
              }
            : {}),
          ...options.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => {
          const buffer = Buffer.from(chunk);
          chunks.push(buffer);
          options.onData?.(buffer);
        });
        response.on('error', (error) =>
          finish(() =>
            reject(
              error instanceof DockerError
                ? error
                : new DockerError(`Docker API 响应失败：${error.message}`, 502),
            ),
          ),
        );
        response.on('end', () => {
          const raw = Buffer.concat(chunks);
          const text = raw.toString('utf8');
          const status = response.statusCode || 500;
          const accepted = options.accept || [200, 201, 204];
          let parsed: unknown = text;
          if (text) {
            try {
              parsed = JSON.parse(text);
            } catch {
              // Some Docker endpoints return a JSON-lines progress stream.
            }
          }
          if (!accepted.includes(status)) {
            const message =
              typeof parsed === 'object' && parsed && 'message' in parsed
                ? String(parsed.message)
                : text || `Docker API returned ${status}`;
            finish(() => reject(new DockerError(message, status, parsed)));
            return;
          }
          finish(() => resolve((options.raw ? raw : text ? parsed : undefined) as T));
        });
      },
    );
    request.on('error', (error) =>
      finish(() =>
        reject(
          error instanceof DockerError
            ? error
                : new DockerError(
                `无法连接 Docker：${error.message}。请检查 Docker Socket 挂载。`,
                503,
                undefined,
                'DOCKER_UNAVAILABLE',
              ),
        ),
      ),
    );
    if (options.timeoutMs) {
      timeout = setTimeout(() => {
        const seconds = Math.ceil(options.timeoutMs! / 1_000);
        const error = new DockerError(
          `Docker 操作超过 ${seconds} 秒，已停止等待`,
          504,
          undefined,
          'DOCKER_TIMEOUT',
        );
        request.destroy();
        finish(() => reject(error));
      }, options.timeoutMs);
      timeout.unref();
    }
    if (payload) request.write(payload);
    request.end();
  });
}

export async function pullImage(
  image: string,
  onProgress?: (progress: ImagePullProgress) => void,
) {
  const startedAt = Date.now();
  console.log(`[镜像拉取] 开始：${image}，超时 ${Math.round(config.updatePullTimeoutMs / 1_000)} 秒`);
  let response: string;
  try {
    let pending = '';
    const parseLines = (flush = false) => {
      const lines = pending.split('\n');
      pending = flush ? '' : lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as {
            status?: string;
            id?: string;
            progress?: string;
            progressDetail?: { current?: number; total?: number };
          };
          if (record.status) {
            onProgress?.({
              status: record.status,
              id: record.id,
              progress: record.progress,
              current: record.progressDetail?.current,
              total: record.progressDetail?.total,
            });
          }
        } catch {
          // Docker progress is newline-delimited JSON; malformed lines are reported by the final parser.
        }
      }
    };
    response = await dockerRequest<string>(
      `/images/create?fromImage=${encodeURIComponent(image)}`,
      {
        method: 'POST',
        headers: {
          'X-Registry-Auth': Buffer.from('{}').toString('base64'),
        },
        timeoutMs: config.updatePullTimeoutMs,
        onData: (chunk) => {
          pending += chunk.toString('utf8');
          parseLines();
        },
      },
    );
    if (pending.trim()) {
      pending += '\n';
      parseLines(true);
    }
  } catch (error) {
    console.error(`[镜像拉取] 失败：${image}`, error);
    throw error;
  }
  const records = String(response || '')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as { error?: string; errorDetail?: { message?: string } }];
      } catch {
        return [];
      }
    });
  const failed = records.find((record) => record.error || record.errorDetail?.message);
  if (failed) {
    const message = failed.errorDetail?.message || failed.error!;
    console.error(`[镜像拉取] 失败：${image}：${message}`);
    throw new DockerError(message, 502, failed, 'IMAGE_PULL_FAILED');
  }
  console.log(`[镜像拉取] 完成：${image}，耗时 ${Date.now() - startedAt} ms`);
}

export type DockerContainer = {
  Id: string;
  Names: string[];
  Image: string;
  ImageID: string;
  State: string;
  Status: string;
  Ports: Array<{
    IP?: string;
    PrivatePort: number;
    PublicPort?: number;
    Type: string;
  }> | null;
  Labels: Record<string, string>;
};

export type DockerImage = {
  Id: string;
  RepoTags: string[] | null;
  RepoDigests: string[] | null;
  Size: number;
  Created: number;
};

export type ContainerInspect = {
  Id: string;
  Name: string;
  Image: string;
  Config: Record<string, unknown> & { Image: string };
  HostConfig: Record<string, unknown> & {
    AutoRemove?: boolean;
    Binds?: string[] | null;
  };
  Mounts: Array<{
    Type: string;
    Name?: string;
    Destination: string;
    RW: boolean;
  }>;
  State: { Running: boolean; Paused: boolean };
  NetworkSettings: {
    Networks: Record<
      string,
      {
        Aliases?: string[];
        Links?: string[];
        IPAMConfig?: unknown;
        DriverOpts?: Record<string, string>;
        MacAddress?: string;
      }
    >;
  };
};

export async function dockerInfo() {
  const [version, info] = await Promise.all([
    dockerRequest<Record<string, unknown>>('/version'),
    dockerRequest<Record<string, unknown>>('/info'),
  ]);
  return { version, info };
}

export function idPath(id: string) {
  if (!/^[a-f0-9]{12,64}$/i.test(id)) {
    throw new DockerError('容器 ID 无效', 400, undefined, 'CONTAINER_ID_INVALID');
  }
  return encodeURIComponent(id);
}
