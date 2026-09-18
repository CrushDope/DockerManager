import http, { type IncomingHttpHeaders } from 'node:http';
import { config } from './config.js';

export class DockerError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly response?: unknown,
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
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
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
          const text = Buffer.concat(chunks).toString('utf8');
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
          finish(() => resolve((text ? parsed : undefined) as T));
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
              ),
        ),
      ),
    );
    if (options.timeoutMs) {
      timeout = setTimeout(() => {
        const seconds = Math.ceil(options.timeoutMs! / 1_000);
        const error = new DockerError(`Docker 操作超过 ${seconds} 秒，已停止等待`, 504);
        request.destroy();
        finish(() => reject(error));
      }, options.timeoutMs);
      timeout.unref();
    }
    if (payload) request.write(payload);
    request.end();
  });
}

export async function pullImage(image: string) {
  const response = await dockerRequest<string>(
    `/images/create?fromImage=${encodeURIComponent(image)}`,
    {
      method: 'POST',
      headers: {
        'X-Registry-Auth': Buffer.from('{}').toString('base64'),
      },
      timeoutMs: config.updatePullTimeoutMs,
    },
  );
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
  if (failed) throw new DockerError(failed.errorDetail?.message || failed.error!, 502);
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
  if (!/^[a-f0-9]{12,64}$/i.test(id)) throw new DockerError('容器 ID 无效', 400);
  return encodeURIComponent(id);
}
