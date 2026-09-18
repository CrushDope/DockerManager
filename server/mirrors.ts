import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { config } from './config.js';
import { dockerRequest, idPath } from './docker.js';
import {
  type MirrorSource,
  mirrorConfigurationMatches,
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
    if [ ! -d /host-docker-config ]; then
      echo "宿主机 Docker 配置目录不存在：/host-docker-config" >&2
      exit 43
    fi
    if ! rm -f "$MISSING"; then
      echo "无法清理宿主机 Docker 配置标记文件，请检查配置目录权限" >&2
      exit 43
    fi
    if [ -f "$TARGET" ]; then
      if ! cp -p "$TARGET" "$BACKUP"; then
        echo "无法备份宿主机 Docker 配置：$TARGET，请检查 userns-remap、SELinux 或目录权限" >&2
        exit 43
      fi
    elif ! touch "$MISSING"; then
      echo "无法写入宿主机 Docker 配置目录，请检查 userns-remap、SELinux 或目录权限" >&2
      exit 43
    fi
    node <<'NODE'
const fs = require('node:fs');
const path = process.env.TARGET_PATH;
const temporary = path + '.nasdocker.tmp';
try {
  let document = {};
  try {
    const raw = fs.readFileSync(path, 'utf8');
    try {
      document = JSON.parse(raw);
    } catch (error) {
      // DockerManager 早期版本可能在文件末尾写入了字面量 "\\n"，自动修复该格式。
      if (raw.endsWith('\\n')) document = JSON.parse(raw.slice(0, -2));
      else throw error;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  document['registry-mirrors'] = JSON.parse(process.env.MIRRORS_JSON || '[]');
  fs.writeFileSync(temporary, JSON.stringify(document, null, 2) + '\n', {mode: 0o600});
  fs.renameSync(temporary, path);
} catch (error) {
  try { fs.rmSync(temporary, {force: true}); } catch {}
  const code = error && error.code ? ' (' + error.code + ')' : '';
  if (error && ['EACCES', 'EPERM', 'EROFS'].includes(error.code)) {
    console.error('无法写入宿主机 Docker 配置：' + path + code + '。请检查 Docker 是否为 rootless 模式，以及宿主机的 userns-remap、SELinux 和目录权限。');
  } else {
    console.error('更新宿主机 Docker 配置失败：' + (error && error.message ? error.message : String(error)));
  }
  process.exit(43);
}
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
if ! kill -HUP $PIDS; then
  echo '配置文件已写入，但没有权限向宿主机 dockerd 发送热重载信号' >&2
  exit 44
fi
`;

let applying: Promise<Awaited<ReturnType<typeof mirrorState>>> | null = null;

export async function activeMirrors() {
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
  const directory = dirname(config.mirrorStorePath);
  const temporary = `${config.mirrorStorePath}.tmp`;
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, `${JSON.stringify({ sources }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporary, config.mirrorStorePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      throw new MirrorError(
        `无法保存镜像源列表到 ${directory}（${code}）。请确认 /data 已挂载为可写卷，且容器用户有写入权限`,
        500,
        'MIRROR_STORE_PERMISSION',
      );
    }
    throw error;
  }
}

function helperAvailable() {
  return /^[a-f0-9]{12,64}$/i.test(process.env.HOSTNAME || '');
}

async function applyCapability() {
  if (!helperAvailable()) {
    return {
      canApply: false,
      applyReason: '当前不在 Docker 容器中运行，无法自动修改宿主机配置',
    };
  }
  try {
    const info = await dockerRequest<{ OperatingSystem?: string; SecurityOptions?: string[] }>('/info');
    if (/docker desktop/i.test(info.OperatingSystem || '')) {
      return {
        canApply: false,
        applyReason: 'Docker Desktop 的镜像源必须在 Docker Desktop 设置的 Docker Engine 页面中修改',
      };
    }
    if ((info.SecurityOptions || []).some((option) => /rootless/i.test(option))) {
      return {
        canApply: false,
        applyReason: 'Rootless Docker 无法通过特权辅助容器修改宿主机 daemon.json',
      };
    }
    return { canApply: true, applyReason: null };
  } catch (error) {
    return {
      canApply: false,
      applyReason: `无法确认宿主机类型：${error instanceof Error ? error.message : String(error)}`,
    };
  }
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
        User: '0:0',
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
          Privileged: true,
          ReadonlyRootfs: true,
          SecurityOpt: ['label=disable'],
          UsernsMode: 'host',
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

async function waitForMirrors(sources: MirrorSource[]) {
  let active: string[] = [];
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      active = await activeMirrors();
      if (mirrorConfigurationMatches(sources, active)) return { applied: true, active };
    } catch {
      // Docker may briefly delay API responses while reloading its configuration.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { applied: false, active };
}

async function mirrorState() {
  const [active, capability] = await Promise.all([activeMirrors(), applyCapability()]);
  const sources = await readCatalog(active);
  return {
    sources: sources.map((source) => ({ ...source, active: active.includes(source.url) })),
    active,
    ...capability,
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
    const capability = await applyCapability();
    if (!capability.canApply) {
      throw new MirrorError(capability.applyReason || '当前环境无法自动应用镜像源', 409, 'MIRROR_APPLY_UNSUPPORTED');
    }
    const sources = normalizeMirrorSources(input);
    const enabled = sources.filter((source) => source.enabled).map((source) => source.url);
    await writeCatalog(sources);
    try {
      await runHelper('apply', enabled);
      const result = await waitForMirrors(sources);
      if (!result.applied) {
        throw new MirrorError(
          `Docker 已收到热重载信号，但 30 秒后配置仍未完全生效。当前 Engine 镜像源：${result.active.join('、') || '无'}。已恢复原配置`,
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
