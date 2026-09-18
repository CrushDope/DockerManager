import type { StartupPlan } from './restart-plan.js';

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export type StartupRuntimeProject = {
  name: string;
  directory: string;
  hostFile: string;
};

export const startupUnitName = 'docker-manager-compose-restore.service';

export function generateStartupUnit() {
  return `[Unit]
Description=DockerManager ordered Compose startup
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/sh /var/lib/docker-manager/compose-startup.sh
TimeoutStartSec=0

[Install]
WantedBy=docker.service
`;
}

function statusFunction(statusFile: string) {
  return `STATUS_FILE=${shellQuote(statusFile)}
write_status() {
  state="$1"
  project="\${2-}"
  temporary="$STATUS_FILE.tmp"
  timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '{"state":"%s","project":"%s","updatedAt":"%s"}\n' "$state" "$project" "$timestamp" > "$temporary"
  mv -f "$temporary" "$STATUS_FILE"
}`;
}

export function generateStartupScript(
  plan: StartupPlan,
  projects: StartupRuntimeProject[],
  statusFile: string,
  logFile: string,
) {
  const runtime = new Map(projects.map((project) => [project.directory, project]));
  const commands = plan.projects
    .filter((preference) => preference.enabled)
    .map((preference) => {
      const project = runtime.get(preference.directory);
      if (!project) throw new Error(`Missing runtime project: ${preference.directory}`);
      const compose = `docker compose -p ${shellQuote(project.name)} -f ${shellQuote(project.hostFile)}`;
      const failure = plan.continueOnError
        ? `had_failure=1; write_status degraded ${shellQuote(project.name)}`
        : `write_status failed ${shellQuote(project.name)}; exit 1`;
      return `write_status starting ${shellQuote(project.name)}
if ${compose} up -d --wait --wait-timeout ${preference.timeoutSeconds}; then
  ids="$(${compose} ps -q)"
  [ -z "$ids" ] || docker update --restart=no $ids >/dev/null
else
  ${failure}
fi`;
    })
    .join('\n\n');

  return `#!/bin/sh
set -u
mkdir -p "$(dirname ${shellQuote(statusFile)})" "$(dirname ${shellQuote(logFile)})"
exec >> ${shellQuote(logFile)} 2>&1
${statusFunction(statusFile)}
write_status waiting
attempt=0
until docker info >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 61 ] || { write_status failed docker; exit 1; }
  sleep 1
done
write_status running
had_failure=0
${commands || ':'}
[ "$had_failure" -eq 0 ] && write_status completed || write_status degraded
`;
}

export function generateRestartScript(
  plan: StartupPlan,
  projects: StartupRuntimeProject[],
  statusFile: string,
  logFile: string,
) {
  const runtime = new Map(projects.map((project) => [project.directory, project]));
  const stopCommands = [...plan.projects]
    .filter((preference) => preference.enabled)
    .sort((left, right) => right.order - left.order)
    .map((preference) => {
      const project = runtime.get(preference.directory);
      if (!project) throw new Error(`Missing runtime project: ${preference.directory}`);
      return `write_status stopping ${shellQuote(project.name)}
docker compose -p ${shellQuote(project.name)} -f ${shellQuote(project.hostFile)} stop --timeout ${Math.min(preference.timeoutSeconds, 300)} || true`;
    })
    .join('\n\n');

  return `#!/bin/sh
set -u
mkdir -p "$(dirname ${shellQuote(statusFile)})" "$(dirname ${shellQuote(logFile)})"
exec >> ${shellQuote(logFile)} 2>&1
${statusFunction(statusFile)}
write_status scheduled
sleep 3
${stopCommands || ':'}
write_status restarting
systemctl restart docker.service
`;
}
