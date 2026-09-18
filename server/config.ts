import { resolve } from 'node:path';

function integer(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
  port: integer(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',
  dockerSocket: process.env.DOCKER_SOCKET || '/var/run/docker.sock',
  composeRoot: resolve(process.env.COMPOSE_ROOT || '/composeFile'),
  mirrorStorePath: resolve(process.env.MIRROR_STORE_PATH || '/data/registry-mirrors.json'),
  hostDockerConfigPath: resolve(
    process.env.HOST_DOCKER_CONFIG_PATH || '/etc/docker/daemon.json',
  ),
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  updateCacheMs: integer(process.env.UPDATE_CACHE_MINUTES, 10) * 60_000,
  updatePullTimeoutMs: integer(process.env.UPDATE_PULL_TIMEOUT_SECONDS, 120) * 1_000,
  bodyLimit: integer(process.env.BODY_LIMIT_BYTES, 2 * 1024 * 1024),
  staticRoot: resolve(process.env.STATIC_ROOT || 'dist/client'),
};

if (process.env.NODE_ENV === 'production' && !config.adminPassword) {
  throw new Error('ADMIN_PASSWORD is required in production');
}
