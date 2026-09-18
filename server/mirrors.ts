import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { config } from './config.js';
import { dockerRequest, idPath } from './docker.js';
import {
  type MirrorSource,
  MirrorValidationError as MirrorError,
  normalizeMirrorSources,
  normalizeMirrorUrl,
} from '../lib/mirror-sources.js';

export { MirrorValidationError as MirrorError } from '../lib/mirror-sources.js';

const helperScript = String.raw`set -eu
TARGET="/host-docker-config/$CONFIG_FILE"
BACKUP="$TARGET.nasdocker.bak"
MISSING="$TARGET.nasdocker.missing"

case "$ACTION" in
  apply)
    rm -f "$MISSING"
    if [ -f "$TARGET" ]; then cp -p "$TARGET" "$BACKUP"; else touch "$MISSING"; fi
    node <<'NODE'
const fs = require('node:fs');
const path = process.env.TARGET_PATH;
const temporary = path + '.nasdocker.tmp';
let document = {};
try {
  const raw = fs.readFileSync(path, 'utf8');
  try {
    document = JSON.parse(raw);
  } catch (error) {
    // NasDocker 早期版本可能在文件末尾写入了字面量 "\\n"，自动修复该格式。
    if (raw.endsWith('\\n')) document = JSON.parse(raw.slice(0, -2));
    else throw error;
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
document['registry-mirrors'] = JSON.parse(process.env.MIRRORS_JSON || '[]');
fs.writeFileSync(temporary, JSON.stringify(document, null, 2) + '\n', {mode: 0o600});
fs.renameSync(temporary, path);
NODE
    ;;
  rollback)
    if [ -f "$BACKUP" ]; then mv -f "$BACKUP" "$TARGET"; elif [ -f "$MISSING" ]; then rm -f "$TARGET"; fi
    rm -f "$MISSING"
    ;;
  cleanup)
    rm -f "$BACKUP" "$MISSING"
    exit 0
    ;;
  *) exit 2 ;;
esac

PIDS="$(pidof dockerd || true)"
[ -n "$PIDS" ] || { echo '未找到宿主机 dockerd 进程' >&2; exit 42; }
kill -HUP $PIDS
`;

let applying: Promise<Awaited<ReturnType<typeof mirrorState>>> | null = null;

async function activeMirrors() {
  const info = await dockerRequest<{ RegistryConfig?: { Mirrors?: string[] } }>('/info');
  return [...new Set((info.RegistryConfig?.Mirrors || []).map(normalizeMirrorUrl))];
}

async function readCatalog(active: string[]) {
  let sources: MirrorSource[] = [];
  try {
    const stored = JSON.parse(await readFile(config.mirrorStorePath, 'utf8')) as {
      sources?: unknown;
    };
    sources = normalizeMirrorSources(stored.sources || []);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new MirrorError(
        `镜像源数据读取失败：${error instanceof Error ? error.message : String(error)}`,
        500,
        'MIRROR_STORE_INVALID',
      );
    }
  }
  const known = new Set(sources.map((source) => source.url));
  for (const url of active) {
    if (!known.has(url)) sources.push({ id: `engine-${sources.length + 1}`, url, enabled: true });
  }
  return sources;
}

async function writeCatalog(sources: MirrorSource[]) {
  await mkdir(dirname(config.mirrorStorePath), { recursive: true });
  const temporary = `${config.mirrorStorePath}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ sources }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporary, config.mirrorStorePath);
}

function helperAvailable() {
  return /^[a-f0-9]{12,64}$/i.test(process.env.HOSTNAME || '');
}

async function helperImage() {
  const self = process.env.HOSTNAME || '';
  if (!helperAvailable()) {
    throw new MirrorError('当前不在 Docker 容器中运行，无法自动修改宿主机配置', 409, 'HELPER_UNAVAILABLE');
  }
  const inspect = await dockerRequest<{ Config?: { Image?: string } }>(
    `/containers/${idPath(self)}/json`,
  );
  if (!inspect.Config?.Image) throw new MirrorError('无法确定 NasDocker 运行镜像', 500);
  return inspect.Config.Image;
}

async function helperLogs(id: string) {
  try {
    return String(
      (await dockerRequest<string>(
        `/containers/${idPath(id)}/logs?stdout=1&stderr=1&tail=30`,
      )) || '',
    ).trim();
  } catch {
    return '';
  }
}

async function runHelper(action: 'apply' | 'rollback' | 'cleanup', mirrors: string[] = []) {
  const image = await helperImage();
  const name = `nasdocker-mirror-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const created = await dockerRequest<{ Id: string }>(
    `/containers/create?name=${encodeURIComponent(name)}`,
    {
      method: 'POST',
      body: {
        Image: image,
        Entrypoint: ['/bin/sh', '-c'],
        Cmd: [helperScript],
        Tty: true,
        Labels: { 'com.nasdocker.helper': 'registry-mirrors' },
        Env: [
          `ACTION=${action}`,
          `CONFIG_FILE=${basename(config.hostDockerConfigPath)}`,
          `TARGET_PATH=/host-docker-config/${basename(config.hostDockerConfigPath)}`,
          `MIRRORS_JSON=${JSON.stringify(mirrors)}`,
        ],
        HostConfig: {
          AutoRemove: false,
          Binds: [`${dirname(config.hostDockerConfigPath)}:/host-docker-config`],
          NetworkMode: 'none',
          PidMode: 'host',
          CapAdd: ['KILL'],
        },
      },
    },
  );
  try {
    await dockerRequest(`/containers/${idPath(created.Id)}/start`, { method: 'POST' });
    const result = await dockerRequest<{ StatusCode: number; Error?: { Message?: string } }>(
      `/containers/${idPath(created.Id)}/wait?condition=not-running`,
      { method: 'POST' },
    );
    if (result.StatusCode !== 0) {
      const logs = await helperLogs(created.Id);
      throw new MirrorError(
        logs || result.Error?.Message || `宿主机配置辅助进程退出码 ${result.StatusCode}`,
        500,
        'HELPER_FAILED',
      );
    }
  } finally {
    await dockerRequest(`/containers/${idPath(created.Id)}?force=1`, {
      method: 'DELETE',
      accept: [204, 404],
    }).catch(() => undefined);
  }
}

function equalMirrors(left: string[], right: string[]) {
  return [...left].sort().join('\n') === [...right].sort().join('\n');
}

async function waitForMirrors(expected: string[]) {
  for (let attempt = 0; attempt < 16; attempt++) {
    try {
      if (equalMirrors(await activeMirrors(), expected)) return true;
    } catch {
      // Docker may briefly delay API responses while reloading its configuration.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function mirrorState() {
  const active = await activeMirrors();
  const sources = await readCatalog(active);
  return {
    sources: sources.map((source) => ({ ...source, active: active.includes(source.url) })),
    active,
    canApply: helperAvailable(),
    hostConfigPath: config.hostDockerConfigPath,
  };
}

export async function getMirrors() {
  return mirrorState();
}

export async function saveMirrors(input: unknown) {
  const sources = normalizeMirrorSources(input);
  await writeCatalog(sources);
  return mirrorState();
}

export async function applyMirrors(input: unknown) {
  if (applying) return applying;
  applying = (async () => {
    const sources = normalizeMirrorSources(input);
    const enabled = sources.filter((source) => source.enabled).map((source) => source.url);
    await writeCatalog(sources);
    try {
      await runHelper('apply', enabled);
      if (!(await waitForMirrors(enabled))) {
        throw new MirrorError(
          'Docker 已收到热重载信号，但生效配置与启用列表不一致，已恢复原配置',
          500,
          'MIRROR_RELOAD_FAILED',
        );
      }
      await runHelper('cleanup');
      return mirrorState();
    } catch (error) {
      await runHelper('rollback').catch(() => undefined);
      throw error;
    }
  })().finally(() => {
    applying = null;
  });
  return applying;
}
