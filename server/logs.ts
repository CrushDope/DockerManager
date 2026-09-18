import { decodeDockerLogs } from '../lib/docker-logs.js';
import { dockerRequest, idPath } from './docker.js';

type LogInspect = {
  Name: string;
  RestartCount?: number;
  Config?: { Image?: string; Tty?: boolean };
  HostConfig?: { LogConfig?: { Type?: string } };
  State?: {
    Status?: string;
    Running?: boolean;
    Paused?: boolean;
    Restarting?: boolean;
    OOMKilled?: boolean;
    Dead?: boolean;
    Pid?: number;
    ExitCode?: number;
    Error?: string;
    StartedAt?: string;
    FinishedAt?: string;
  };
};

export async function getContainerLogs(id: string, tailInput: number, sinceSeconds: number) {
  const safeId = idPath(id);
  const tail = Math.min(2_000, Math.max(50, Math.round(tailInput) || 500));
  const since = Math.min(7 * 24 * 60 * 60, Math.max(0, Math.round(sinceSeconds) || 0));
  const inspect = await dockerRequest<LogInspect>(`/containers/${safeId}/json`);
  const query = new URLSearchParams({
    stdout: '1',
    stderr: '1',
    timestamps: '1',
    details: '1',
    tail: String(tail),
  });
  if (since) query.set('since', String(Math.floor(Date.now() / 1_000) - since));
  const buffer = await dockerRequest<Buffer>(`/containers/${safeId}/logs?${query}`, {
    raw: true,
    timeoutMs: 15_000,
  });
  const state = inspect.State || {};
  return {
    container: {
      id,
      name: inspect.Name?.replace(/^\//, '') || id.slice(0, 12),
      image: inspect.Config?.Image || 'unknown',
      state: state.Status || 'unknown',
      running: Boolean(state.Running),
      paused: Boolean(state.Paused),
      restarting: Boolean(state.Restarting),
      oomKilled: Boolean(state.OOMKilled),
      dead: Boolean(state.Dead),
      pid: state.Pid || 0,
      exitCode: state.ExitCode ?? null,
      error: state.Error || '',
      startedAt: state.StartedAt || null,
      finishedAt: state.FinishedAt || null,
      restartCount: inspect.RestartCount || 0,
      logDriver: inspect.HostConfig?.LogConfig?.Type || 'default',
    },
    query: { tail, sinceSeconds: since },
    lines: decodeDockerLogs(buffer, Boolean(inspect.Config?.Tty)),
    readAt: new Date().toISOString(),
  };
}
