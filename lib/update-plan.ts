export function isManagerContainer(containerName: string, managerContainerName: string) {
  return containerName.replace(/^\//, '') === managerContainerName.replace(/^\//, '');
}

export function composeUpgradeCommands(service: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(service)) {
    throw new Error(`Compose 服务名称无效：${service || '空名称'}`);
  }
  return [
    ['pull', service],
    ['up', '-d', '--no-deps', service],
  ];
}

export function composeConfigMatches(directory: string, configFiles: string) {
  const suffix = `/${directory.replaceAll('\\', '/')}/docker-compose.yml`;
  return configFiles
    .split(',')
    .map((value) => value.trim().replaceAll('\\', '/'))
    .some((value) => value.endsWith(suffix));
}
