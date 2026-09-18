export type DockerPort = {
  IP?: string;
  PrivatePort: number;
  PublicPort?: number;
  Type: string;
};

export type PortMapping = {
  hostIp: string | null;
  host: number | null;
  container: number;
  protocol: string;
};

export function normalizePortMappings(ports: DockerPort[] | null): PortMapping[] {
  const mappings = new Map<string, PortMapping>();
  for (const port of ports || []) {
    const rawIp = port.IP || '';
    const wildcard = rawIp === '0.0.0.0' || rawIp === '::' || rawIp === '';
    const hostIp = wildcard ? null : rawIp;
    const mapping = {
      hostIp,
      host: port.PublicPort || null,
      container: port.PrivatePort,
      protocol: port.Type.toUpperCase(),
    };
    const key = `${hostIp || '*'}:${mapping.host || '-'}:${mapping.container}:${mapping.protocol}`;
    if (!mappings.has(key)) mappings.set(key, mapping);
  }
  return [...mappings.values()];
}
