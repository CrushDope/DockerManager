import {
  DockerError,
  dockerRequest,
  idPath,
  pullImage,
  type ImagePullProgress,
  type ContainerInspect,
  type DockerContainer,
} from './docker.js';
import { randomUUID } from 'node:crypto';
import { ComposeError, runCompose, findComposeProject } from './compose.js';
import { config } from './config.js';
import { remoteManifestDigest } from './registry.js';
import { activeMirrors } from './mirrors.js';
import { composeUpgradeCommands, isManagerContainer } from '../lib/update-plan.js';

export class UpdateError extends Error {
  constructor(
    message: string,
    readonly statusCode = 409,
    readonly code = 'UPDATE_ERROR',
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export type UpdateState = {
  image: string;
  status: 'checking' | 'available' | 'current' | 'error';
  targetImageId?: string;
  remoteDigest?: string;
  outdatedImageIds?: string[];
  error?: string;
  errorCode?: string;
  errorDetails?: unknown;
  checkedAt: string;
};

export type UpdateTask = {
  id: string;
  containerId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  stage: 'queued' | 'inspecting' | 'pulling' | 'recreating' | 'starting' | 'completed' | 'failed';
  percentage: number;
  message: string;
  image?: string;
  containerName?: string;
  logs: Array<{ timestamp: string; level: 'info' | 'error'; message: string }>;
  error?: string;
  errorCode?: string;
  errorDetails?: unknown;
  result?: unknown;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
};

type UpgradeReporter = (
  stage: UpdateTask['stage'],
  percentage: number,
  message: string,
  level?: 'info' | 'error',
) => void;

const updates = new Map<string, UpdateState>();
let activeScan: Promise<UpdateState[]> | null = null;
const activeUpgrades = new Map<string, string>();
const updateTasks = new Map<string, UpdateTask>();

function taskSnapshot(task: UpdateTask): UpdateTask {
  return { ...task, logs: [...task.logs] };
}

function pruneTasks() {
  const cutoff = Date.now() - 60 * 60_000;
  for (const [id, task] of updateTasks) {
    if (task.completedAt && Date.parse(task.completedAt) < cutoff) updateTasks.delete(id);
  }
}

function updateTaskReporter(task: UpdateTask): UpgradeReporter {
  return (stage, percentage, message, level = 'info') => {
    task.stage = stage;
    task.percentage = Math.max(task.percentage, Math.min(100, Math.round(percentage)));
    task.message = message;
    task.updatedAt = new Date().toISOString();
    const previous = task.logs.at(-1);
    if (!previous || previous.message !== message || previous.level !== level) {
      task.logs.push({ timestamp: task.updatedAt, level, message });
      if (task.logs.length > 500) task.logs.splice(0, task.logs.length - 500);
    }
    console[level === 'error' ? 'error' : 'log'](`[升级任务 ${task.id}] ${message}`);
  };
}

function cleanOutput(value: string) {
  // oxlint-disable-next-line no-control-regex
  return value.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '');
}

function outputReporter(report: UpgradeReporter, stage: UpdateTask['stage'], fallbackPercentage: number) {
  let pending = '';
  return (_stream: 'stdout' | 'stderr', chunk: string) => {
    pending += cleanOutput(chunk).replaceAll('\r', '\n');
    const lines = pending.split('\n');
    pending = lines.pop() || '';
    for (const line of lines.map((item) => item.trim()).filter(Boolean)) {
      const matched = line.match(/\b(\d{1,3}(?:\.\d+)?)%/);
      const parsed = matched ? Number(matched[1]) : 0;
      const percentage = parsed > 0 && parsed <= 100
        ? Math.min(69, 5 + Math.round(parsed * 0.64))
        : fallbackPercentage;
      report(stage, percentage, line);
    }
  };
}

function pullProgressReporter(report: UpgradeReporter) {
  const layers = new Map<string, { current: number; total: number }>();
  return (progress: ImagePullProgress) => {
    if (progress.id && progress.total && progress.total > 0) {
      layers.set(progress.id, {
        current: Math.min(progress.current || 0, progress.total),
        total: progress.total,
      });
    }
    const totals = [...layers.values()].reduce(
      (sum, layer) => ({ current: sum.current + layer.current, total: sum.total + layer.total }),
      { current: 0, total: 0 },
    );
    const percentage = totals.total
      ? Math.min(69, 5 + Math.round((totals.current / totals.total) * 64))
      : 8;
    const detail = [progress.id, progress.status, progress.progress].filter(Boolean).join(' · ');
    report('pulling', percentage, detail || '正在拉取镜像');
  };
}

// 规范化镜像名，确保 "redis" 和 "redis:latest" 使用同一个 key
function normalizeImageName(image: string) {
  if (image.includes('@')) return image;
  const lastPart = image.split('/').at(-1) || '';
  if (!lastPart.includes(':')) return `${image}:latest`;
  return image;
}

export function updateFor(image: string, imageId: string) {
  const key = normalizeImageName(image);
  const state = updates.get(key);
  if (!state) return null;
  return {
    ...state,
    available:
      state.status === 'available' && Boolean(state.outdatedImageIds?.includes(imageId)),
  };
}

export function listUpdateStates() {
  return [...updates.values()];
}

export function updateScanRunning() {
  return activeScan !== null;
}

async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const output: R[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return output;
}

export async function checkLatestImages(force = false) {
  if (activeScan) return activeScan;
  const now = Date.now();
  if (
    !force &&
    updates.size &&
    [...updates.values()].every(
      (state) => now - Date.parse(state.checkedAt) < config.updateCacheMs,
    )
  ) {
    return listUpdateStates();
  }
  activeScan = (async () => {
    const [containers, mirrors] = await Promise.all([
      dockerRequest<DockerContainer[]>('/containers/json?all=1'),
      activeMirrors(),
    ]);
    // 从容器镜像和本地镜像 tag 双向收集需要检查的镜像名
    const containerImages = containers.map((item) => item.Image).filter(isLatestImage);
    let localImages: Array<{ Id: string; RepoTags: string[] | null }> = [];
    try {
      localImages = await dockerRequest<Array<{ Id: string; RepoTags: string[] | null }>>('/images/json');
    } catch {
      // 忽略本地镜像列表读取失败
    }
    const localTags = localImages.flatMap((img) => img.RepoTags || []).filter(isLatestImage);
    const latest = [...new Set([...containerImages, ...localTags].map(normalizeImageName))];
    const currentImages = new Set(latest);
    for (const cachedImage of updates.keys()) {
      if (!currentImages.has(cachedImage)) updates.delete(cachedImage);
    }
    return mapConcurrent(latest, 2, async (image) => {
      const checkedAt = new Date().toISOString();
      updates.set(image, { image, status: 'checking', checkedAt });
      try {
        const remoteDigest = await remoteManifestDigest(image, mirrors);
        if (!remoteDigest) {
          const state: UpdateState = {
            image,
            status: 'error',
            error: '无法获取远程镜像 digest',
            checkedAt,
          };
          updates.set(image, state);
          console.error(`[更新检查] 镜像 ${image} 无法获取远程 digest`);
          return state;
        }
        // 收集需要检查的镜像 ID：容器使用的 + 当前 tag 指向的本地镜像
        const imageIdSet = new Set<string>();
        containers
          .filter((container) => normalizeImageName(container.Image) === image)
          .forEach((container) => imageIdSet.add(container.ImageID));
        localImages
          .filter((img) => (img.RepoTags || []).some((tag) => normalizeImageName(tag) === image))
          .forEach((img) => imageIdSet.add(img.Id));
        try {
          const localImage = await dockerRequest<{ Id: string }>(
            `/images/${encodeURIComponent(image)}/json`,
          );
          if (localImage.Id) imageIdSet.add(localImage.Id);
        } catch {
          // 该 tag 可能只被容器引用而没有独立的镜像记录
        }
        const imageIds = [...imageIdSet];
        console.log(`[更新检查] 镜像 ${image}:`, {
          remoteDigest,
          localImageIds: imageIds,
        });
        const inspected = await mapConcurrent(imageIds, 2, async (imageId) => {
          const local = await dockerRequest<{ RepoDigests?: string[] }>(
            `/images/${encodeURIComponent(imageId)}/json`,
          );
          const localDigests = (local.RepoDigests || []).map(d => d.split('@').at(-1));
          const current = localDigests.includes(remoteDigest);
          console.log(`[更新检查] 本地镜像 ${imageId}:`, {
            repoDigests: local.RepoDigests,
            extractedDigests: localDigests,
            remoteDigest,
            current,
          });
          return { imageId, current };
        });
        const outdatedImageIds = inspected
          .filter((local) => !local.current)
          .map((local) => local.imageId);
        const state: UpdateState = {
          image,
          status: outdatedImageIds.length ? 'available' : 'current',
          remoteDigest,
          outdatedImageIds,
          checkedAt,
        };
        console.log(`[更新检查] 镜像 ${image} 结果:`, {
          status: state.status,
          outdatedImageIds,
        });
        updates.set(image, state);
        return state;
      } catch (error) {
        const state: UpdateState = {
          image,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
          checkedAt,
        };
        console.error(`[更新检查] 镜像 ${image} 检查失败:`, error);
        updates.set(image, state);
        return state;
      }
    });
  })().finally(() => {
    activeScan = null;
  });
  return activeScan;
}

function isLatestImage(image: string) {
  const withoutDigest = image.split('@')[0];
  if (image.includes('@')) return false;
  const lastPart = withoutDigest.split('/').at(-1) || '';
  return !lastPart.includes(':') || lastPart.endsWith(':latest');
}

function sanitizeNetworks(networks: ContainerInspect['NetworkSettings']['Networks']) {
  return Object.fromEntries(
    Object.entries(networks).map(([name, endpoint]) => [
      name,
      {
        Aliases: endpoint.Aliases,
        Links: endpoint.Links,
        IPAMConfig: endpoint.IPAMConfig,
        DriverOpts: endpoint.DriverOpts,
        MacAddress: endpoint.MacAddress,
      },
    ]),
  );
}

function preserveVolumes(inspect: ContainerInspect) {
  const binds = [...(inspect.HostConfig.Binds || [])];
  const boundDestinations = new Set(
    binds.map((bind) => bind.split(':').slice(-2)[0]).filter(Boolean),
  );
  for (const mount of inspect.Mounts) {
    if (mount.Type !== 'volume' || !mount.Name || boundDestinations.has(mount.Destination)) {
      continue;
    }
    binds.push(`${mount.Name}:${mount.Destination}${mount.RW ? '' : ':ro'}`);
  }
  return binds;
}

async function performUpgrade(id: string, report: UpgradeReporter = () => undefined) {
  const safeId = idPath(id);
  report('inspecting', 2, '正在读取容器与镜像配置');
  const inspect = await dockerRequest<ContainerInspect>(`/containers/${safeId}/json`);
  const image = inspect.Config.Image;
  const name = inspect.Name.replace(/^\//, '');
  report('inspecting', 4, `目标容器 ${name}，镜像 ${image}`);
  if (isManagerContainer(name, config.managerContainerName)) {
    throw new UpdateError(
      'DockerManager 无法在自己的进程中停止并重建自身，请在宿主机执行 docker compose pull docker-manager && docker compose up -d docker-manager',
      409,
      'SELF_UPDATE_REQUIRES_HOST',
      { container: name, image },
    );
  }
  if (!isLatestImage(image)) {
    throw new UpdateError('仅支持升级 latest 镜像', 400, 'LATEST_ONLY');
  }

  const labels = (inspect.Config.Labels || {}) as Record<string, string>;
  const project = labels['com.docker.compose.project'];
  const service = labels['com.docker.compose.service'];
  if (project && service) {
    const composeProject = await findComposeProject(project);
    if (!composeProject) {
      throw new UpdateError(
        `找不到 Compose 项目 ${project} 的配置文件。请将项目目录映射到 /composeFile 后再升级`,
        409,
        'COMPOSE_FILE_NOT_MAPPED',
        {
          project,
          service,
          originalFiles: labels['com.docker.compose.project.config_files'] || null,
          originalWorkingDirectory: labels['com.docker.compose.project.working_dir'] || null,
        },
      );
    }
    const [pull, up] = composeUpgradeCommands(service);
    console.log(`[升级] Compose 项目 ${project}/${service}：先拉取 ${image}，成功后仅重建目标服务`);
    report('pulling', 5, `开始拉取 Compose 服务 ${project}/${service}`);
    await runCompose(composeProject.file, pull, project, outputReporter(report, 'pulling', 10));
    report('recreating', 72, '镜像拉取完成，正在重建目标 Compose 服务');
    await runCompose(composeProject.file, up, project, outputReporter(report, 'recreating', 82));
    report('starting', 95, `Compose 服务 ${project}/${service} 已启动`);
    updates.delete(normalizeImageName(image));
    return { mode: 'compose', project, service };
  }

  if (inspect.HostConfig.AutoRemove) {
    throw new UpdateError(
      '自动删除容器无法安全重建，请改用 Compose 管理后再升级',
      409,
      'AUTO_REMOVE_UNSUPPORTED',
    );
  }
  report('pulling', 5, `开始通过宿主机 Docker Engine 拉取 ${image}`);
  await pullImage(image, pullProgressReporter(report));
  report('recreating', 72, '镜像拉取完成，正在保留配置并重建容器');

  const backupName = `${name}.nasdocker-backup-${Date.now()}`;
  const wasRunning = inspect.State.Running;
  const wasPaused = inspect.State.Paused;
  let createdId: string | null = null;
  await dockerRequest(`/containers/${safeId}/rename?name=${encodeURIComponent(backupName)}`, {
    method: 'POST',
  });
  try {
    if (wasPaused) await dockerRequest(`/containers/${safeId}/unpause`, { method: 'POST' });
    if (wasRunning || wasPaused) {
      await dockerRequest(`/containers/${safeId}/stop?t=20`, { method: 'POST', accept: [204, 304] });
    }
    const created = await dockerRequest<{ Id: string }>(
      `/containers/create?name=${encodeURIComponent(name)}`,
      {
        method: 'POST',
        body: {
          ...inspect.Config,
          Image: image,
          HostConfig: {
            ...inspect.HostConfig,
            Binds: preserveVolumes(inspect),
          },
          NetworkingConfig: { EndpointsConfig: sanitizeNetworks(inspect.NetworkSettings.Networks) },
        },
      },
    );
    createdId = created.Id;
    report('starting', 88, `新容器已创建：${created.Id.slice(0, 12)}`);
    if (wasRunning || wasPaused) {
      await dockerRequest(`/containers/${idPath(created.Id)}/start`, { method: 'POST' });
      report('starting', 94, '新容器已启动');
    }
    if (wasPaused) {
      await dockerRequest(`/containers/${idPath(created.Id)}/pause`, { method: 'POST' });
    }
    await dockerRequest(`/containers/${safeId}?force=1`, { method: 'DELETE' });
    updates.delete(normalizeImageName(image));
    return { mode: 'standalone', containerId: created.Id };
  } catch (error) {
    if (createdId) {
      await dockerRequest(`/containers/${idPath(createdId)}?force=1`, {
        method: 'DELETE',
        accept: [204, 404],
      }).catch(() => undefined);
    }
    await dockerRequest(`/containers/${safeId}/rename?name=${encodeURIComponent(name)}`, {
      method: 'POST',
    }).catch(() => undefined);
    if (wasRunning || wasPaused) {
      await dockerRequest(`/containers/${safeId}/start`, {
        method: 'POST',
        accept: [204, 304],
      }).catch(() => undefined);
    }
    if (wasPaused) {
      await dockerRequest(`/containers/${safeId}/pause`, {
        method: 'POST',
        accept: [204, 409],
      }).catch(() => undefined);
    }
    throw error;
  }
}

export async function upgradeContainer(id: string) {
  const safeId = idPath(id);
  if (activeUpgrades.has(safeId)) {
    throw new UpdateError('该容器正在升级，请等待当前任务完成', 409, 'UPDATE_IN_PROGRESS');
  }
  activeUpgrades.set(safeId, 'direct');
  try {
    return await performUpgrade(safeId);
  } finally {
    activeUpgrades.delete(safeId);
  }
}

export function startContainerUpgrade(id: string) {
  const safeId = idPath(id);
  const existingTask = activeUpgrades.get(safeId);
  if (existingTask) {
    throw new UpdateError(
      '该容器正在升级，请等待当前任务完成',
      409,
      'UPDATE_IN_PROGRESS',
      existingTask === 'direct' ? undefined : { taskId: existingTask },
    );
  }
  pruneTasks();
  const now = new Date().toISOString();
  const task: UpdateTask = {
    id: randomUUID(),
    containerId: safeId,
    status: 'queued',
    stage: 'queued',
    percentage: 0,
    message: '升级任务已创建',
    logs: [{ timestamp: now, level: 'info', message: '升级任务已创建' }],
    startedAt: now,
    updatedAt: now,
  };
  updateTasks.set(task.id, task);
  activeUpgrades.set(safeId, task.id);
  const report = updateTaskReporter(task);
  void (async () => {
    task.status = 'running';
    try {
      const result = await performUpgrade(safeId, report);
      task.result = result;
      task.status = 'completed';
      report('completed', 100, '镜像升级完成');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      task.status = 'failed';
      task.error = message;
      if (error instanceof UpdateError || error instanceof DockerError || error instanceof ComposeError) {
        task.errorCode = error.code;
      }
      if (error instanceof UpdateError || error instanceof ComposeError) {
        task.errorDetails = error.details;
      }
      report('failed', task.percentage, `升级失败：${message}`, 'error');
    } finally {
      task.completedAt = new Date().toISOString();
      task.updatedAt = task.completedAt;
      activeUpgrades.delete(safeId);
    }
  })();
  return taskSnapshot(task);
}

export function getUpdateTask(id: string) {
  if (!/^[a-f0-9-]{36}$/i.test(id)) {
    throw new UpdateError('升级任务 ID 无效', 400, 'UPDATE_TASK_INVALID');
  }
  const task = updateTasks.get(id);
  if (!task) throw new UpdateError('升级任务不存在或已过期', 404, 'UPDATE_TASK_NOT_FOUND');
  return taskSnapshot(task);
}
