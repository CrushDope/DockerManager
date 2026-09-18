import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ProxyAgent, type Dispatcher } from 'undici';
import { config } from './config.js';
import {
  normalizeUpdateProxy,
  proxyBypassed,
  type UpdateProxySettings,
} from '../lib/update-proxy.js';

export { UpdateProxyValidationError as UpdateProxyError } from '../lib/update-proxy.js';

let agent: ProxyAgent | null = null;
let agentUrl = '';

function defaults(): UpdateProxySettings {
  return normalizeUpdateProxy({
    enabled: Boolean(config.updateCheckProxy),
    url: config.updateCheckProxy,
    noProxy: config.updateCheckNoProxy,
  });
}

export async function getUpdateProxy() {
  try {
    return normalizeUpdateProxy(JSON.parse(await readFile(config.updateProxyPath, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaults();
    throw error;
  }
}

export async function saveUpdateProxy(input: unknown) {
  const settings = normalizeUpdateProxy(input);
  await mkdir(dirname(config.updateProxyPath), { recursive: true });
  const temporary = `${config.updateProxyPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporary, config.updateProxyPath);
  if (agent && agentUrl !== settings.url) {
    await agent.close().catch(() => undefined);
    agent = null;
    agentUrl = '';
  }
  return settings;
}

export async function proxyDispatcher(target: string): Promise<Dispatcher | undefined> {
  const settings = await getUpdateProxy();
  if (!settings.enabled || proxyBypassed(target, settings.noProxy)) return undefined;
  if (!agent || agentUrl !== settings.url) {
    if (agent) await agent.close().catch(() => undefined);
    agent = new ProxyAgent(settings.url);
    agentUrl = settings.url;
  }
  return agent;
}
