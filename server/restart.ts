import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { config } from './config.js';
import { listComposeProjects, runCompose, type ComposeProject } from './compose.js';
import { dockerRequest, idPath } from './docker.js';
import {
  normalizeStartupPlan,
  RestartPlanValidationError,
  type StartupPlan,
} from '../lib/restart-plan.js';
import {
  generateRestartScript,
  generateStartupScript,
  generateStartupUnit,
  startupUnitName,
  type StartupRuntimeProject,
} from '../lib/systemd-compose.js';

export class RestartError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly code = 'RESTART_ERROR',
  ) {
    super(message);
  }
}

type SelfInspect = {
  Config?: { Image?: string; Labels?: Record<string, string> };
  Mounts?: Array<{ Source?: string; Destination?: string }>;
};

type ManagedContainer = {
  Id: string;
  Labels?: Record<string, string>;
};

const helperScript = String.raw`set -eu
ROOT=/host
INSTALL_DIR="$ROOT/var/lib/docker-manager"
UNIT_DIR="$ROOT/etc/systemd/system"
mkdir -p "$INSTALL_DIR" "$UNIT_DIR"

decode_file() {
  value="$1"
  target="$2"
  temporary="$target.tmp"
  printf '%s' "$value" | base64 -d > "$temporary"
  chmod 700 "$temporary"
  mv -f "$temporary" "$target"
}

# 使用 nsenter 进入宿主机的 PID 1 命名空间执行 systemctl，
# 这样才能访问宿主机的 D-Bus 套接字，避免 "Failed to connect to bus" 错误。
host_exec() {
  nsenter -t 1 -m -u -i -n -p -- "$@"
}

case "$ACTION" in
  install)
    [ -d "$ROOT/run/systemd/system" ] || { echo '宿主机未使用 systemd，无法安装 Docker 启动顺序钩子' >&2; exit 45; }
    decode_file "$STARTUP_B64" "$INSTALL_DIR/compose-startup.sh"
    decode_file "$RESTART_B64" "$INSTALL_DIR/restart-docker.sh"
    decode_file "$UNIT_B64" "$UNIT_DIR/docker-manager-compose-restore.service"
    chmod 644 "$UNIT_DIR/docker-manager-compose-restore.service"
    if ! host_exec systemctl daemon-reload 2>/tmp/nsenter-err; then
      err="$(cat /tmp/nsenter-err 2>/dev/null || true)"
      if echo "$err" | grep -q "Failed to connect to bus"; then
        echo "无法连接到宿主机 systemd D-Bus，请确认容器以特权模式运行并共享 PID 命名空间（PidMode: host）" >&2
        echo "详细错误: $err" >&2
      else
        echo "$err" >&2
      fi
      exit 47
    fi
    host_exec systemctl enable docker-manager-compose-restore.service
    ;;
  restart)
    [ -x "$INSTALL_DIR/restart-docker.sh" ] || { echo '请先保存 Compose 启动顺序' >&2; exit 46; }
    host_exec systemd-run --unit="docker-manager-restart-$JOB_ID" /bin/sh /var/lib/docker-manager/restart-docker.sh
    ;;
  *) exit 2 ;;
esac
`;

function helperAvailable() {
  return /^[a-f0-9]{12,64}$/i.test(process.env.HOSTNAME || '');
}

async function hostHookAvailable() {
  if (!helperAvailable()) return false;
  try {
    const info = await dockerRequest<{ OperatingSystem?: string; SecurityOptions?: string[] }>('/info');
    const desktop = /docker desktop/i.test(info.OperatingSystem || '');
    const rootless = (info.SecurityOptions || []).some((option) => /rootless/i.test(option));
    return !desktop && !rootless;
  } catch {
    return false;
  }
}

async function inspectSelf() {
  const self = process.env.HOSTNAME || '';
  if (!helperAvailable()) {
    throw new RestartError('当前不在 Docker 容器中运行，无法安装宿主机 systemd 钩子', 409, 'HELPER_UNAVAILABLE');
  }
  return dockerRequest<SelfInspect>(`/containers/${idPath(self)}/json`);
}

function mountSource(inspect: SelfInspect, destination: string) {
  const source = inspect.Mounts?.find((mount) => mount.Destination === destination)?.Source;
  if (!source || !isAbsolute(source)) {
    throw new RestartError(`未找到 ${destination} 对应的宿主机挂载路径`, 409, 'HOST_MOUNT_MISSING');
  }
  return source;
}

function hostPath(containerPath: string, containerRoot: string, hostRoot: string) {
  const suffix = relative(containerRoot, containerPath);
  if (suffix.startsWith('..') || isAbsolute(suffix)) {
    throw new RestartError(`路径不在挂载目录内：${containerPath}`, 500, 'HOST_PATH_INVALID');
  }
  return join(hostRoot, ...suffix.split(sep));
}

async function runtimeProjects(projects: ComposeProject[], inspect: SelfInspect) {
  const composeSource = mountSource(inspect, config.composeRoot);
  return projects.map<StartupRuntimeProject>((project) => ({
    name: project.name,
    directory: project.directory,
    hostFile: hostPath(project.file, config.composeRoot, composeSource),
  }));
}

async function readSavedPlan(projects: ComposeProject[]) {
  const runningDirectories = projects
    .filter((project) => project.status === 'running' || project.status === 'partial')
    .map((project) => project.directory);
  try {
    const input = JSON.parse(await readFile(config.restartPlanPath, 'utf8'));
    return normalizeStartupPlan(input, projects.map((project) => project.directory), runningDirectories);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return normalizeStartupPlan({}, projects.map((project) => project.directory), runningDirectories);
  }
}

async function writePlan(plan: StartupPlan) {
  await mkdir(dirname(config.restartPlanPath), { recursive: true });
  const temporary = `${config.restartPlanPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, config.restartPlanPath);
}

async function startupPlanInstalled() {
  try {
    await readFile(config.restartPlanPath, 'utf8');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function helperLogs(id: string) {
  try {
    return String(await dockerRequest<string>(`/containers/${idPath(id)}/logs?stdout=1&stderr=1&tail=50`)).trim();
  } catch {
    return '';
  }
}

async function runHelper(action: 'install' | 'restart', files?: { startup: string; restart: string; unit: string }) {
  const inspect = await inspectSelf();
  const image = inspect.Config?.Image;
  if (!image) throw new RestartError('无法确定 DockerManager 运行镜像', 500);
  const name = `docker-manager-systemd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const env = [`ACTION=${action}`, `JOB_ID=${randomUUID().replaceAll('-', '')}`];
  if (files) {
    env.push(
      `STARTUP_B64=${Buffer.from(files.startup).toString('base64')}`,
      `RESTART_B64=${Buffer.from(files.restart).toString('base64')}`,
      `UNIT_B64=${Buffer.from(files.unit).toString('base64')}`,
    );
  }
  const created = await dockerRequest<{ Id: string }>(`/containers/create?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    body: {
      Image: image,
      User: '0:0',
      Entrypoint: ['/bin/sh', '-c'],
      Cmd: [helperScript],
      Env: env,
      Labels: { 'com.docker-manager.helper': 'systemd' },
      HostConfig: {
        AutoRemove: false,
        Binds: ['/:/host'],
        NetworkMode: 'none',
        Privileged: true,
        SecurityOpt: ['label=disable'],
        UsernsMode: 'host',
        PidMode: 'host',
      },
    },
  });
  try {
    await dockerRequest(`/containers/${idPath(created.Id)}/start`, { method: 'POST' });
    const result = await dockerRequest<{ StatusCode: number; Error?: { Message?: string } }>(
      `/containers/${idPath(created.Id)}/wait?condition=not-running`,
      { method: 'POST' },
    );
    if (result.StatusCode !== 0) {
      throw new RestartError(
        (await helperLogs(created.Id)) || result.Error?.Message || `systemd 辅助进程退出码 ${result.StatusCode}`,
        500,
        'SYSTEMD_HELPER_FAILED',
      );
    }
  } finally {
    await dockerRequest(`/containers/${idPath(created.Id)}?force=1`, {
      method: 'DELETE',
      accept: [204, 404],
    }).catch(() => undefined);
  }
}

async function projectContainers(project: string) {
  const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${project}`] }));
  return dockerRequest<ManagedContainer[]>(`/containers/json?all=1&filters=${filters}`);
}

function composeRestartPolicy(value: unknown) {
  const text = typeof value === 'string' ? value : 'no';
  if (text === 'always' || text === 'unless-stopped') return { Name: text, MaximumRetryCount: 0 };
  if (text.startsWith('on-failure')) {
    const maximum = Number(text.split(':')[1] || 0);
    return { Name: 'on-failure', MaximumRetryCount: Number.isInteger(maximum) ? maximum : 0 };
  }
  return { Name: 'no', MaximumRetryCount: 0 };
}

async function setProjectRestartPolicy(project: ComposeProject, managed: boolean) {
  const containers = await projectContainers(project.name);
  let services: Record<string, { restart?: string }> = {};
  if (!managed) {
    try {
      const { stdout } = await runCompose(project.file, ['config', '--format', 'json'], project.name);
      services = (JSON.parse(stdout) as { services?: Record<string, { restart?: string }> }).services || {};
    } catch {
      // Fall back to "no" if the Compose file cannot be rendered.
    }
  }
  await Promise.all(containers.map((container) => {
    if (container.Id === process.env.HOSTNAME) return Promise.resolve();
    const service = container.Labels?.['com.docker.compose.service'] || '';
    const restartPolicy = managed ? { Name: 'no', MaximumRetryCount: 0 } : composeRestartPolicy(services[service]?.restart);
    return dockerRequest(`/containers/${idPath(container.Id)}/update`, {
      method: 'POST',
      body: { RestartPolicy: restartPolicy },
    });
  }));
}

export async function getStartupSettings() {
  const projects = await listComposeProjects();
  const [plan, canInstall, installed] = await Promise.all([
    readSavedPlan(projects),
    hostHookAvailable(),
    startupPlanInstalled(),
  ]);
  let status: unknown = null;
  try {
    status = JSON.parse(await readFile(config.restartStatusPath, 'utf8'));
  } catch {
    // A status file exists only after the systemd hook runs for the first time.
  }
  return {
    ...plan,
    canInstall,
    installed,
    integration: startupUnitName,
    status,
  };
}

export async function saveStartupSettings(input: unknown) {
  const projects = await listComposeProjects();
  const runningDirectories = projects
    .filter((project) => project.status === 'running' || project.status === 'partial')
    .map((project) => project.directory);
  let plan: StartupPlan;
  try {
    plan = normalizeStartupPlan(input, projects.map((project) => project.directory), runningDirectories);
  } catch (error) {
    if (error instanceof RestartPlanValidationError) {
      throw new RestartError(error.message, error.statusCode, error.code);
    }
    throw error;
  }
  if (!(await hostHookAvailable())) {
    throw new RestartError(
      '宿主机必须是使用 systemd 的非 rootless Linux Docker Engine',
      409,
      'SYSTEMD_UNAVAILABLE',
    );
  }
  const inspect = await inspectSelf();
  const selfProject = inspect.Config?.Labels?.['com.docker.compose.project'];
  const enabledProjects = projects.filter((project) => plan.projects.some((item) => item.directory === project.directory && item.enabled));
  if (selfProject && enabledProjects.some((project) => project.name === selfProject)) {
    throw new RestartError('DockerManager 自身所在的 Compose 项目不能加入启动顺序', 409, 'SELF_PROJECT_MANAGED');
  }
  const previous = await readSavedPlan(projects);
  const previousEnabled = new Set(previous.projects.filter((item) => item.enabled).map((item) => item.directory));
  const enabled = new Set(plan.projects.filter((item) => item.enabled).map((item) => item.directory));
  const runtime = await runtimeProjects(projects, inspect);
  const dataSource = mountSource(inspect, dirname(config.restartStatusPath));
  const statusFile = hostPath(config.restartStatusPath, dirname(config.restartStatusPath), dataSource);
  const logFile = hostPath(config.restartLogPath, dirname(config.restartLogPath), dataSource);
  const files = {
    startup: generateStartupScript(plan, runtime, statusFile, logFile),
    restart: generateRestartScript(plan, runtime, statusFile, logFile),
    unit: generateStartupUnit(),
  };
  await runHelper('install', files);
  await Promise.all(projects.map((project) => {
    if (enabled.has(project.directory)) return setProjectRestartPolicy(project, true);
    if (previousEnabled.has(project.directory)) return setProjectRestartPolicy(project, false);
    return Promise.resolve();
  }));
  await writePlan(plan);
  return getStartupSettings();
}

export async function scheduleDockerRestart() {
  if (!(await startupPlanInstalled())) {
    throw new RestartError('请先在 Compose 项目页面保存并启用启动顺序', 409, 'STARTUP_HOOK_NOT_INSTALLED');
  }
  const projects = await listComposeProjects();
  const plan = await readSavedPlan(projects);
  if (!plan.projects.some((project) => project.enabled)) {
    throw new RestartError('没有启用的 Compose 启动顺序', 409, 'STARTUP_PLAN_EMPTY');
  }
  await runHelper('restart');
  return { scheduled: true };
}
