export type PortMapping = {
  hostIp: string | null;
  host: number | null;
  container: number;
  protocol: string;
};

export type UpdateStatus = {
  image: string;
  status: 'checking' | 'available' | 'current' | 'error';
  targetImageId?: string;
  error?: string;
  checkedAt: string;
  available?: boolean;
};

export type Container = {
  id: string;
  name: string;
  image: string;
  imageId: string;
  project: string | null;
  service: string | null;
  self: boolean;
  state: 'running' | 'paused' | 'stopped';
  status: string;
  ports: PortMapping[];
  memory: string;
  update: UpdateStatus | null;
};

export type ImageRecord = {
  id: string;
  tag: string;
  digests: string[];
  size: number;
  created: number;
  containers: string[];
  update: UpdateStatus | null;
};

export type ComposeProject = {
  name: string;
  directory: string;
  file: string;
  services: string[];
  status: 'running' | 'partial' | 'stopped';
};

export type SystemInfo = {
  name: string;
  serverVersion: string;
  operatingSystem: string;
  architecture: string;
  containers: number;
  images: number;
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, {
    ...options,
    headers,
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
    details?: unknown;
  };
  if (!response.ok) {
    throw new ApiError(payload.error || `请求失败（${response.status}）`, response.status, payload.code, payload.details);
  }
  return payload as T;
}

export function post<T>(path: string, data: Record<string, unknown> = {}) {
  return api<T>(path, { method: 'POST', body: JSON.stringify(data) });
}

export function put<T>(path: string, data: Record<string, unknown>) {
  return api<T>(path, { method: 'PUT', body: JSON.stringify(data) });
}

export function formatBytes(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`;
}
