export class RegistryReferenceError extends Error {}

export type RegistryReference = {
  registry: string;
  repository: string;
  tag: string;
  protocol: 'http:' | 'https:';
};

export function parseRegistryReference(image: string): RegistryReference {
  if (image.includes('@')) throw new RegistryReferenceError('摘要镜像不参与 latest 检查');
  const lastSlash = image.lastIndexOf('/');
  const lastColon = image.lastIndexOf(':');
  const hasTag = lastColon > lastSlash;
  const tag = hasTag ? image.slice(lastColon + 1) : 'latest';
  const path = hasTag ? image.slice(0, lastColon) : image;
  const parts = path.split('/');
  const first = parts[0];
  const explicitRegistry = first.includes('.') || first.includes(':') || first === 'localhost';
  let registry = explicitRegistry ? first : 'registry-1.docker.io';
  let repository = explicitRegistry ? parts.slice(1).join('/') : path;
  if (registry === 'docker.io' || registry === 'index.docker.io') registry = 'registry-1.docker.io';
  if (registry === 'registry-1.docker.io' && !repository.includes('/')) {
    repository = `library/${repository}`;
  }
  if (!registry || !repository || !tag) {
    throw new RegistryReferenceError(`镜像名称无效：${image}`);
  }
  const protocol = registry === 'localhost' || registry.startsWith('localhost:') || registry.startsWith('127.') ? 'http:' : 'https:';
  return { registry, repository, tag, protocol };
}

export function registryCandidates(reference: RegistryReference, mirrors: string[]) {
  const origin = `${reference.protocol}//${reference.registry}`;
  return [
    ...new Set(
      reference.registry === 'registry-1.docker.io'
        ? [...mirrors.map((mirror) => mirror.replace(/\/$/, '')), origin]
        : [origin],
    ),
  ];
}
