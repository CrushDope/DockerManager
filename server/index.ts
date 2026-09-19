import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import {
  DockerError,
  dockerInfo,
  dockerRequest,
  idPath,
  type DockerContainer,
  type DockerImage,
} from './docker.js';
import {
  ComposeError,
  composeAction,
  deployCompose,
  listComposeProjects,
  readComposeFile,
  runCompose,
} from './compose.js';
import {
  checkLatestImages,
  getUpdateTask,
  listUpdateStates,
  startContainerUpgrade,
  updateFor,
  updateScanRunning,
  UpdateError,
} from './updates.js';
import { applyMirrors, getMirrors, MirrorError, saveMirrors } from './mirrors.js';
import { benchmarkMirrors } from './mirror-benchmark.js';
import { getContainerLogs } from './logs.js';
import { MirrorValidationError } from '../lib/mirror-sources.js';
import {
  getUpdateProxy,
  saveUpdateProxy,
  UpdateProxyError,
} from './update-proxy.js';
import {
  getStartupSettings,
  RestartError,
  saveStartupSettings,
  scheduleDockerRestart,
} from './restart.js';
import { validateCompose } from '../lib/validate-compose.js';
import { normalizePortMappings } from '../lib/docker-ports.js';

type Json = Record<string, unknown> | unknown[];

function json(response: ServerResponse, status: number, body: Json) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(payload);
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(request: IncomingMessage) {
  if (!config.adminPassword) return process.env.NODE_ENV !== 'production';
  const value = request.headers.authorization;
  if (value?.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(value.slice(6), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (
        separator > 0 &&
        safeEqual(decoded.slice(0, separator), config.adminUsername) &&
        safeEqual(decoded.slice(separator + 1), config.adminPassword)
      ) return true;
    } catch {
      return false;
    }
  }
  const cookie = request.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('nasdocker_session='))
    ?.slice('nasdocker_session='.length);
  if (!cookie) return false;
  const [expires, signature] = cookie.split('.');
  if (!expires || !signature || Number(expires) < Date.now()) return false;
  return safeEqual(signature, sessionSignature(expires));
}

function sessionSignature(expires: string) {
  return createHmac('sha256', config.adminPassword || 'nasdocker-development')
    .update(`${config.adminUsername}:${expires}`)
    .digest('base64url');
}

function sessionCookie(request: IncomingMessage, clear = false) {
  const secure = request.headers['x-forwarded-proto'] === 'https';
  if (clear) return `nasdocker_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
  const expires = String(Date.now() + 12 * 60 * 60 * 1000);
  return `nasdocker_session=${expires}.${sessionSignature(expires)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secure ? '; Secure' : ''}`;
}

function mutationAllowed(request: IncomingMessage) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > config.bodyLimit) throw new HttpError('请求内容过大', 413);
    chunks.push(Buffer.from(chunk));
  }
  if (!chunks.length) return {} as Record<string, unknown>;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new HttpError('请求 JSON 格式无效', 400);
  }
}

class HttpError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly code = 'BAD_REQUEST',
    readonly details?: unknown,
  ) {
    super(message);
  }
}

function memoryText(bytes: number | null) {
  if (bytes === null) return '—';
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
}

async function containerMemory(id: string, running: boolean) {
  if (!running) return null;
  try {
    const stats = await dockerRequest<{
      memory_stats?: { usage?: number; stats?: { inactive_file?: number } };
    }>(`/containers/${idPath(id)}/stats?stream=0&one-shot=1`);
    const usage = stats.memory_stats?.usage;
    return usage === undefined
      ? null
      : Math.max(0, usage - (stats.memory_stats?.stats?.inactive_file || 0));
  } catch {
    return null;
  }
}

async function containers() {
  const records = await dockerRequest<DockerContainer[]>('/containers/json?all=1');
  return Promise.all(
    records.map(async (container) => {
      const memory = await containerMemory(container.Id, container.State === 'running');
      const state =
        container.State === 'running'
          ? 'running'
          : container.State === 'paused'
            ? 'paused'
            : 'stopped';
      return {
        id: container.Id,
        name: container.Names[0]?.replace(/^\//, '') || container.Id.slice(0, 12),
        image: container.Image,
        imageId: container.ImageID,
        project: container.Labels?.['com.docker.compose.project'] || null,
        service: container.Labels?.['com.docker.compose.service'] || null,
        self:
          (container.Names[0]?.replace(/^\//, '') || '') === config.managerContainerName,
        state,
        status: container.Status,
        ports: normalizePortMappings(container.Ports),
        memory: memoryText(memory),
        update: updateFor(container.Image, container.ImageID),
      };
    }),
  );
}

async function images() {
  const [records, allContainers] = await Promise.all([
    dockerRequest<DockerImage[]>('/images/json?all=0'),
    dockerRequest<DockerContainer[]>('/containers/json?all=1'),
  ]);
  return records.flatMap((image) =>
    (image.RepoTags || []).map((tag) => ({
      id: image.Id,
      tag,
      digests: image.RepoDigests || [],
      size: image.Size,
      created: image.Created,
      containers: allContainers
        .filter((container) => container.ImageID === image.Id || container.Image === tag)
        .map((container) => container.Names[0]?.replace(/^\//, '')),
      update: updateFor(tag, image.Id),
    })),
  );
}

function actionPath(pathname: string) {
  const match = pathname.match(/^\/api\/containers\/([a-f0-9]{12,64})\/(start|stop|pause|unpause|restart|upgrade)$/i);
  return match ? { id: match[1], action: match[2] } : null;
}

async function api(request: IncomingMessage, response: ServerResponse, url: URL) {
  const method = request.method || 'GET';
  if (method !== 'GET' && !mutationAllowed(request)) {
    throw new HttpError('请求来源无效', 403, 'ORIGIN_REJECTED');
  }
  if (method === 'GET' && url.pathname === '/api/health') {
    await dockerRequest('/_ping');
    return json(response, 200, { ok: true });
  }
  if (method === 'GET' && url.pathname === '/api/system') {
    const { version, info } = await dockerInfo();
    return json(response, 200, {
      name: info.Name,
      serverVersion: version.Version,
      operatingSystem: info.OperatingSystem,
      architecture: info.Architecture || version.Arch || 'unknown',
      containers: info.Containers,
      images: info.Images,
    });
  }
  if (method === 'GET' && url.pathname === '/api/containers') {
    return json(response, 200, { containers: await containers() });
  }
  const containerLogs = url.pathname.match(/^\/api\/containers\/([a-f0-9]{12,64})\/logs$/i);
  if (method === 'GET' && containerLogs) {
    const tail = Number(url.searchParams.get('tail') || 500);
    const sinceSeconds = Number(url.searchParams.get('since') || 0);
    if (!Number.isFinite(tail) || !Number.isFinite(sinceSeconds)) {
      throw new HttpError('日志查询参数无效', 400, 'LOG_QUERY_INVALID');
    }
    return json(response, 200, await getContainerLogs(containerLogs[1], tail, sinceSeconds));
  }
  if (method === 'GET' && url.pathname === '/api/images') {
    return json(response, 200, { images: await images() });
  }
  if (method === 'GET' && url.pathname === '/api/updates') {
    return json(response, 200, { updates: listUpdateStates(), running: updateScanRunning() });
  }
  const updateTask = url.pathname.match(/^\/api\/updates\/tasks\/([a-f0-9-]{36})$/i);
  if (method === 'GET' && updateTask) {
    return json(response, 200, getUpdateTask(updateTask[1]));
  }
  if (method === 'POST' && url.pathname === '/api/updates/check') {
    const input = await body(request);
    void checkLatestImages(input.force === true).catch((error) => {
      console.error('latest image scan failed', error);
    });
    return json(response, 202, { updates: listUpdateStates(), running: true });
  }
  if (method === 'GET' && url.pathname === '/api/updates/proxy') {
    return json(response, 200, await getUpdateProxy());
  }
  if (method === 'PUT' && url.pathname === '/api/updates/proxy') {
    const input = await body(request);
    return json(response, 200, await saveUpdateProxy(input));
  }
  const containerAction = actionPath(url.pathname);
  if (method === 'POST' && containerAction) {
    if (containerAction.action === 'upgrade') {
      return json(response, 202, {
        ok: true,
        task: startContainerUpgrade(containerAction.id),
      });
    }
    const paths: Record<string, string> = {
      start: 'start',
      stop: 'stop?t=20',
      pause: 'pause',
      unpause: 'unpause',
      restart: 'restart?t=20',
    };
    await dockerRequest(
      `/containers/${idPath(containerAction.id)}/${paths[containerAction.action]}`,
      { method: 'POST', accept: [204, 304] },
    );
    return json(response, 200, { ok: true });
  }
  if (method === 'GET' && url.pathname === '/api/compose/projects') {
    return json(response, 200, { projects: await listComposeProjects() });
  }
  if (method === 'GET' && url.pathname === '/api/docker/startup-order') {
    return json(response, 200, await getStartupSettings());
  }
  if (method === 'PUT' && url.pathname === '/api/docker/startup-order') {
    return json(response, 200, await saveStartupSettings(await body(request)));
  }
  if (method === 'POST' && url.pathname === '/api/docker/restart') {
    return json(response, 202, await scheduleDockerRestart());
  }
  if (method === 'GET' && url.pathname === '/api/compose/file') {
    const directory = url.searchParams.get('directory') || '';
    return json(response, 200, await readComposeFile(directory));
  }
  if (method === 'POST' && url.pathname === '/api/compose/validate') {
    const input = await body(request);
    const content = typeof input.content === 'string' ? input.content : '';
    const issues = validateCompose(content);
    if (issues.length) return json(response, 200, { valid: false, issues });
    const directory = typeof input.directory === 'string' ? input.directory : '';
    const project = typeof input.project === 'string' ? input.project : 'nasdocker-check';
    const file = (await readComposeFile(directory)).file;
    const temporary = `${file}.validation.yml`;
    const { mkdir, writeFile, rm } = await import('node:fs/promises');
    await mkdir(dirname(file), { recursive: true });
    try {
      await writeFile(temporary, content, 'utf8');
      await runCompose(temporary, ['config', '--quiet'], project);
      return json(response, 200, { valid: true, issues: [] });
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
  if (method === 'POST' && url.pathname === '/api/compose/deploy') {
    const input = await body(request);
    return json(response, 200, {
      ok: true,
      result: await deployCompose({
        project: typeof input.project === 'string' ? input.project : '',
        directory: typeof input.directory === 'string' ? input.directory : '',
        content: typeof input.content === 'string' ? input.content : undefined,
        mode:
          input.mode === 'overwrite' || input.mode === 'reference' ? input.mode : 'create',
      }),
    });
  }
  const composeMatch = url.pathname.match(
    /^\/api\/compose\/([a-z0-9][a-z0-9_-]*)\/(start|stop|restart|down|pull-up)$/,
  );
  if (method === 'POST' && composeMatch) {
    return json(response, 200, {
      ok: true,
      result: await composeAction(composeMatch[1], composeMatch[2] as Parameters<typeof composeAction>[1]),
    });
  }
  if (method === 'GET' && url.pathname === '/api/docker/mirrors') {
    return json(response, 200, await getMirrors());
  }
  if (method === 'PUT' && url.pathname === '/api/docker/mirrors') {
    const input = await body(request);
    return json(response, 200, await saveMirrors(input.sources));
  }
  if (method === 'POST' && url.pathname === '/api/docker/mirrors/apply') {
    const input = await body(request);
    return json(response, 200, await applyMirrors(input.sources));
  }
  if (method === 'POST' && url.pathname === '/api/docker/mirrors/benchmark') {
    const input = await body(request);
    return json(response, 200, await benchmarkMirrors(input.sources, input.image));
  }
  throw new HttpError('接口不存在', 404, 'NOT_FOUND');
}

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/x-component; charset=utf-8',
  '.woff2': 'font/woff2',
};

async function staticFile(request: IncomingMessage, response: ServerResponse, url: URL) {
  const decoded = decodeURIComponent(url.pathname);
  const relative = normalize(decoded).replace(/^[/\\]+/, '');
  let file = join(config.staticRoot, relative || 'index.html');
  if (file !== config.staticRoot && !file.startsWith(config.staticRoot + sep)) {
    throw new HttpError('路径无效', 400);
  }
  try {
    const info = await stat(file);
    if (info.isDirectory()) file = join(file, 'index.html');
  } catch {
    file = join(config.staticRoot, 'index.html');
  }
  const info = await stat(file);
  const isDocument = file.endsWith('index.html') || extname(file) === '.txt';
  response.writeHead(200, {
    'Content-Type': mime[extname(file)] || 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': isDocument ? 'no-cache' : 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'",
  });
  if (request.method === 'HEAD') return response.end();
  createReadStream(file).pipe(response);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (url.pathname === '/api/auth/session' && request.method === 'GET') {
      return json(response, 200, { authenticated: authorized(request) });
    }
    if (url.pathname === '/api/auth/login' && request.method === 'POST') {
      if (!mutationAllowed(request)) throw new HttpError('请求来源无效', 403);
      const input = await body(request);
      const valid =
        typeof input.username === 'string' &&
        typeof input.password === 'string' &&
        safeEqual(input.username, config.adminUsername) &&
        safeEqual(input.password, config.adminPassword);
      if (!valid) throw new HttpError('用户名或密码错误', 401, 'LOGIN_FAILED');
      response.setHeader('Set-Cookie', sessionCookie(request));
      return json(response, 200, { ok: true });
    }
    if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
      response.setHeader('Set-Cookie', sessionCookie(request, true));
      return json(response, 200, { ok: true });
    }
    if (url.pathname.startsWith('/api/')) {
      if (!authorized(request)) return json(response, 401, { error: '请先登录', code: 'UNAUTHORIZED' });
      return await api(request, response, url);
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      throw new HttpError('方法不允许', 405, 'METHOD_NOT_ALLOWED');
    }
    await staticFile(request, response, url);
  } catch (error) {
    console.error(error);
    if (response.headersSent) return response.end();
    const status =
      error instanceof HttpError ||
      error instanceof DockerError ||
      error instanceof ComposeError ||
      error instanceof UpdateError ||
      error instanceof MirrorError ||
      error instanceof MirrorValidationError ||
      error instanceof UpdateProxyError ||
      error instanceof RestartError
        ? error.statusCode
        : 500;
    const code =
      error instanceof HttpError ||
      error instanceof DockerError ||
      error instanceof ComposeError ||
      error instanceof UpdateError ||
      error instanceof MirrorError ||
      error instanceof MirrorValidationError ||
      error instanceof UpdateProxyError ||
      error instanceof RestartError
        ? error.code
        : 'INTERNAL_ERROR';
    const details =
      error instanceof HttpError || error instanceof ComposeError || error instanceof UpdateError
        ? error.details
        : undefined;
    json(response, status, {
      error: error instanceof Error ? error.message : '服务器内部错误',
      code,
      ...(details === undefined ? {} : { details }),
    });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`DockerManager listening on http://${config.host}:${config.port}`);
  if (!config.adminPassword) console.warn('Development mode: authentication is disabled');
});
