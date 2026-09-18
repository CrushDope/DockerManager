import {
  dockerRequest,
  idPath,
  pullImage,
  type ContainerInspect,
  type DockerContainer,
} from './docker.js';
import { runCompose, findComposeProject } from './compose.js';
import { config } from './config.js';
import { remoteManifestDigest } from './registry.js';
import { activeMirrors } from './mirrors.js';

export type UpdateState = {
  image: string;
  status: 'checking' | 'available' | 'current' | 'error';
  targetImageId?: string;
  remoteDigest?: string;
  outdatedImageIds?: string[];
  error?: string;
  checkedAt: string;
};

const updates = new Map<string, UpdateState>();
let activeScan: Promise<UpdateState[]> | null = null;

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

export async function upgradeContainer(id: string) {
  const safeId = idPath(id);
  const inspect = await dockerRequest<ContainerInspect>(`/containers/${safeId}/json`);
  const image = inspect.Config.Image;
  if (!isLatestImage(image)) throw new Error('仅支持升级 latest 镜像');

  const labels = (inspect.Config.Labels || {}) as Record<string, string>;
  const project = labels['com.docker.compose.project'];
  const service = labels['com.docker.compose.service'];
  if (project && service) {
    const composeProject = await findComposeProject(project);
    if (!composeProject) throw new Error(`找不到 Compose 项目 ${project} 的配置文件`);
    // 更新流程：停止整个 Compose → 拉取镜像 → 重新启动整个 Compose
    console.log(`[升级] Compose 项目 ${project}：停止 → 拉取 ${image} → 启动`);
    await runCompose(composeProject.file, ['stop'], project);
    try {
      await runCompose(composeProject.file, ['pull'], project);
    } catch (error) {
      // 拉取失败时尝试重新启动，避免服务长时间停机
      await runCompose(composeProject.file, ['up', '-d', '--remove-orphans'], project).catch(() => undefined);
      throw error;
    }
    await runCompose(composeProject.file, ['up', '-d', '--remove-orphans'], project);
    updates.delete(normalizeImageName(image));
    return { mode: 'compose', project, service };
  }

  await pullImage(image);

  if (inspect.HostConfig.AutoRemove) {
    throw new Error('自动删除容器无法安全重建，请改用 Compose 管理后再升级');
  }
  const name = inspect.Name.replace(/^\//, '');
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
    if (wasRunning || wasPaused) {
      await dockerRequest(`/containers/${idPath(created.Id)}/start`, { method: 'POST' });
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
