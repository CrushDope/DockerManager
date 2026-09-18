export type UpdateProxySettings = {
  enabled: boolean;
  url: string;
  noProxy: string;
};

export class UpdateProxyValidationError extends Error {
  readonly statusCode = 400;
  readonly code = 'UPDATE_PROXY_INVALID';
}

export function normalizeUpdateProxy(input: unknown): UpdateProxySettings {
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const enabled = value.enabled === true;
  const rawUrl = typeof value.url === 'string' ? value.url.trim() : '';
  const noProxy = typeof value.noProxy === 'string' ? value.noProxy.trim() : '';
  if (rawUrl.length > 2048 || noProxy.length > 4096 || /[\r\n]/.test(rawUrl + noProxy)) {
    throw new UpdateProxyValidationError('代理配置过长或包含非法换行');
  }
  if (enabled && !rawUrl) throw new UpdateProxyValidationError('启用代理时必须填写代理地址');
  let url = rawUrl;
  if (rawUrl) {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new UpdateProxyValidationError('代理地址格式无效');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new UpdateProxyValidationError('更新检查代理仅支持 HTTP 或 HTTPS');
    }
    if (!parsed.hostname || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new UpdateProxyValidationError('代理地址只能包含协议、认证信息、主机和端口');
    }
    url = parsed.toString().replace(/\/$/, '');
  }
  return { enabled, url, noProxy };
}

export function proxyBypassed(target: string, noProxy: string) {
  const url = new URL(target);
  const hostname = url.hostname.toLowerCase();
  const host = url.host.toLowerCase();
  return noProxy
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => {
      if (entry === '*') return true;
      if (entry.includes(':') && !entry.startsWith('.')) return host === entry;
      if (entry.startsWith('.')) return hostname.endsWith(entry);
      return hostname === entry || hostname.endsWith(`.${entry}`);
    });
}
