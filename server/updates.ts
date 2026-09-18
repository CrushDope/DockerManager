import {
  dockerRequest,
  idPath,
  pullImage,
  type ContainerInspect,
  type DockerContainer,
} from './docker.js';
import { runCompose, findComposeProject } from './compose.js';
import { config } from './config.js';

export type UpdateState = {
  image: string;
  status: 'checking' | 'available' | 'current' | 'error';
  targetImageId?: string;
  error?: string;
  checkedAt: string;
};

const updates = new Map<string, UpdateState>();
let activeScan: Promise<UpdateState[]> | null = null;

export function updateFor(image: string, imageId: string) {
  const state = updates.get(image);
  if (!state) return null;
  return {
    ...state,
    available: state.status === 'available' && state.targetImageId !== imageId,
  };
}

export function listUpdateStates() {
  return [...updates.values()];
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
    const containers = await dockerRequest<DockerContainer[]>('/containers/json?all=1');
    const latest = [...new Set(containers.map((item) => item.Image).filter(isLatestImage))];
    return mapConcurrent(latest, 2, async (image) => {
      const checkedAt = new Date().toISOString();
      updates.set(image, { image, status: 'checking', checkedAt });
      try {
        await pullImage(image);
        const target = await dockerRequest<{ Id: string }>(
          `/images/${encodeURIComponent(image)}/json`,
        );
        const affected = containers.some(
          (container) => container.Image === image && container.ImageID !== target.Id,
        );
        const state: UpdateState = {
          image,
          status: affected ? 'available' : 'current',
          targetImageId: target.Id,
          checkedAt,
        };
        updates.set(image, state);
        return state;
      } catch (error) {
        const state: UpdateState = {
          image,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
          checkedAt,
        };
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
  await pullImage(image);

  const labels = (inspect.Config.Labels || {}) as Record<string, string>;
  const project = labels['com.docker.compose.project'];
  const service = labels['com.docker.compose.service'];
  if (project && service) {
    const composeProject = await findComposeProject(project);
    if (!composeProject) throw new Error(`找不到 Compose 项目 ${project} 的配置文件`);
    await runCompose(composeProject.file, ['pull', service], project);
    await runCompose(composeProject.file, ['up', '-d', '--no-deps', service], project);
    updates.delete(image);
    return { mode: 'compose', project, service };
  }

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
    updates.delete(image);
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
