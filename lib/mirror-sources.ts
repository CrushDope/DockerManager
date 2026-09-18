import { randomUUID } from 'node:crypto';

export type MirrorSource = {
  id: string;
  url: string;
  enabled: boolean;
};

export class MirrorValidationError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, statusCode = 400, code = 'MIRROR_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function normalizeMirrorUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new MirrorValidationError('镜像源地址必须使用 HTTP 或 HTTPS');
  }
  if (url.username || url.password) {
    throw new MirrorValidationError('镜像源地址不能包含用户名或密码');
  }
  return url.toString().replace(/\/$/, '');
}

export function normalizeMirrorSources(input: unknown): MirrorSource[] {
  if (!Array.isArray(input) || input.length > 20) {
    throw new MirrorValidationError('镜像源列表无效');
  }
  const seen = new Set<string>();
  return input.map((item) => {
    if (!item || typeof item !== 'object') {
      throw new MirrorValidationError('镜像源记录无效');
    }
    const record = item as Record<string, unknown>;
    if (typeof record.url !== 'string') {
      throw new MirrorValidationError('镜像源地址必须是字符串');
    }
    const url = normalizeMirrorUrl(record.url.trim());
    if (seen.has(url)) throw new MirrorValidationError(`镜像源重复：${url}`);
    seen.add(url);
    const id =
      typeof record.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(record.id)
        ? record.id
        : randomUUID();
    return { id, url, enabled: record.enabled === true };
  });
}

export function prioritizeMirrorSource(sources: MirrorSource[], value: string) {
  const url = normalizeMirrorUrl(value);
  const index = sources.findIndex((source) => source.url === url);
  const required =
    index === -1
      ? { id: 'update-check-source', url, enabled: true }
      : { ...sources[index], enabled: true };
  return [required, ...sources.filter((_, sourceIndex) => sourceIndex !== index)];
}
