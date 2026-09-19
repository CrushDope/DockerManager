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
  restartPlanPath: resolve(process.env.RESTART_PLAN_PATH || '/data/compose-startup.json'),
  restartStatusPath: resolve(process.env.RESTART_STATUS_PATH || '/data/docker-restart.json'),
  restartLogPath: resolve(process.env.RESTART_LOG_PATH || '/data/docker-restart.log'),
  updateProxyPath: resolve(process.env.UPDATE_PROXY_PATH || '/data/update-check-proxy.json'),
  hostDockerConfigPath: resolve(
    process.env.HOST_DOCKER_CONFIG_PATH || '/etc/docker/daemon.json',
  ),
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  managerContainerName: process.env.MANAGER_CONTAINER_NAME || 'docker-manager',
  updateCacheMs: integer(process.env.UPDATE_CACHE_MINUTES, 10) * 60_000,
  updateCheckTimeoutMs: integer(process.env.UPDATE_CHECK_TIMEOUT_SECONDS, 30) * 1_000,
  updatePullTimeoutMs: integer(process.env.UPDATE_PULL_TIMEOUT_SECONDS, 900) * 1_000,
  mirrorBenchmarkTimeoutMs: integer(process.env.MIRROR_BENCHMARK_TIMEOUT_SECONDS, 8) * 1_000,
  updateCheckProxy: process.env.UPDATE_CHECK_PROXY || '',
  updateCheckNoProxy: process.env.UPDATE_CHECK_NO_PROXY || '',
  bodyLimit: integer(process.env.BODY_LIMIT_BYTES, 2 * 1024 * 1024),
  staticRoot: resolve(process.env.STATIC_ROOT || 'dist/client'),
};

if (process.env.NODE_ENV === 'production' && !config.adminPassword) {
  throw new Error('ADMIN_PASSWORD is required in production');
}
