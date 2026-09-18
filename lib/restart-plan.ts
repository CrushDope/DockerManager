export type StartupPreference = {
  directory: string;
  enabled: boolean;
  order: number;
  timeoutSeconds: number;
};

export type StartupPlan = {
  projects: StartupPreference[];
  continueOnError: boolean;
};

export class RestartPlanValidationError extends Error {
  readonly statusCode = 400;
  readonly code = 'RESTART_PLAN_INVALID';
}

function positiveInteger(value: unknown, fallback: number) {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

export function normalizeStartupPlan(input: unknown, availableDirectories: string[]): StartupPlan {
  const available = new Set(availableDirectories);
  const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const rawProjects = Array.isArray(record.projects) ? record.projects : [];
  if (rawProjects.length > 200) throw new RestartPlanValidationError('启动顺序项目过多');

  const seenDirectories = new Set<string>();
  const seenOrders = new Set<number>();
  const projects = rawProjects.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new RestartPlanValidationError('启动顺序记录无效');
    }
    const value = item as Record<string, unknown>;
    const directory = typeof value.directory === 'string' ? value.directory : '';
    if (!available.has(directory)) {
      throw new RestartPlanValidationError(`Compose 目录不存在：${directory || '空目录'}`);
    }
    if (seenDirectories.has(directory)) {
      throw new RestartPlanValidationError(`Compose 目录重复：${directory}`);
    }
    seenDirectories.add(directory);
    const enabled = value.enabled !== false;
    const order = positiveInteger(value.order, index + 1);
    if (enabled && seenOrders.has(order)) {
      throw new RestartPlanValidationError(`启动顺序 ${order} 重复`);
    }
    if (enabled) seenOrders.add(order);
    const timeoutSeconds = Math.min(1800, positiveInteger(value.timeoutSeconds, 180));
    return { directory, enabled, order, timeoutSeconds };
  });

  let nextOrder = projects.reduce((maximum, project) => Math.max(maximum, project.order), 0) + 1;
  for (const directory of availableDirectories) {
    if (seenDirectories.has(directory)) continue;
    projects.push({ directory, enabled: false, order: nextOrder++, timeoutSeconds: 180 });
  }

  projects.sort((left, right) => left.order - right.order || left.directory.localeCompare(right.directory));
  return { projects, continueOnError: record.continueOnError === true };
}

export function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
