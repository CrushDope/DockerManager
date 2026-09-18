import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { validateCompose } from '../lib/validate-compose.js';
import { validateComposeDirectory } from '../lib/compose-path.js';

export class ComposeError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly code = 'COMPOSE_ERROR',
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export type ComposeProject = {
  name: string;
  directory: string;
  file: string;
  services: string[];
  status: 'running' | 'partial' | 'stopped';
};

export function validateDirectory(directory: string) {
  try {
    return validateComposeDirectory(directory);
  } catch {
    throw new ComposeError('保存位置必须是 /composeFile 下的有效子目录');
  }
}

async function assertInsideRoot(path: string) {
  const root = await realpath(config.composeRoot);
  const actual = await realpath(path);
  if (actual !== root && !actual.startsWith(root + sep)) {
    throw new ComposeError('目录超出 /composeFile 挂载范围', 400, 'INVALID_PATH');
  }
  return actual;
}

export async function composeFile(directory: string, create = false) {
  const normalized = validateDirectory(directory);
  const directoryPath = resolve(config.composeRoot, normalized);
  if (create) await mkdir(directoryPath, { recursive: true });
  await assertInsideRoot(directoryPath);
  return join(directoryPath, 'docker-compose.yml');
}

function composeProjectName(directory: string) {
  return directory
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'compose-project';
}

export async function runCommand(command: string, args: string[], cwd?: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolveCommand, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const maxOutput = 1024 * 1024;
    let size = 0;
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size <= maxOutput) stdout.push(Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk) => {
      size += chunk.length;
      if (size <= maxOutput) stderr.push(Buffer.from(chunk));
    });
    child.on('error', (error) => reject(new ComposeError(error.message, 503)));
    child.on('close', (code) => {
      const result = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (code !== 0) {
        reject(
          new ComposeError(
            result.stderr.trim() || result.stdout.trim() || `命令退出码 ${code}`,
            400,
            'COMPOSE_COMMAND_FAILED',
          ),
        );
      } else resolveCommand(result);
    });
  });
}

export async function runCompose(file: string, args: string[], project?: string) {
  await assertInsideRoot(dirname(file));
  const name = project || composeProjectName(relative(config.composeRoot, dirname(file)));
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    throw new ComposeError('Compose 项目名称无效');
  }
  return runCommand('docker', ['compose', '-p', name, '-f', file, ...args], dirname(file));
}

export async function readComposeFile(directory: string) {
  try {
    const file = await composeFile(directory);
    return { exists: true, content: await readFile(file, 'utf8'), file };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, content: null, file: join(config.composeRoot, directory, 'docker-compose.yml') };
    }
    throw error;
  }
}

async function validateWithDocker(file: string, project: string) {
  await runCompose(file, ['config', '--quiet'], project);
}

export async function deployCompose(input: {
  project: string;
  directory: string;
  content?: string;
  mode: 'create' | 'overwrite' | 'reference';
}) {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(input.project)) {
    throw new ComposeError('项目名称格式无效');
  }
  const file = await composeFile(input.directory, true);
  let exists = false;
  try {
    exists = (await stat(file)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (exists && input.mode === 'create') {
    throw new ComposeError(
      'docker-compose.yml 已存在，请选择覆盖或引用',
      409,
      'FILE_EXISTS',
      { content: await readFile(file, 'utf8') },
    );
  }
  if (!exists && input.mode === 'reference') {
    throw new ComposeError('要引用的 docker-compose.yml 不存在', 404, 'FILE_NOT_FOUND');
  }

  if (input.mode === 'reference') {
    await validateWithDocker(file, input.project);
  } else {
    const content = input.content || '';
    const issues = validateCompose(content);
    if (issues.length) {
      throw new ComposeError('Compose 内容格式校验失败', 400, 'YAML_INVALID', issues);
    }
    const temporary = join(dirname(file), `.nasdocker-${randomUUID()}.yml`);
    try {
      await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await validateWithDocker(temporary, input.project);
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
  await runCompose(file, ['up', '-d', '--remove-orphans'], input.project);
  await writeFile(
    join(dirname(file), '.nasdocker.json'),
    `${JSON.stringify({ project: input.project }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  return { project: input.project, file, directory: input.directory };
}

async function findComposeFiles(root: string, depth = 0): Promise<string[]> {
  if (depth > 5) return [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === 'docker-compose.yml' && depth > 0) files.push(path);
    if (entry.isDirectory()) files.push(...(await findComposeFiles(path, depth + 1)));
  }
  return files;
}

async function composePs(file: string, project: string) {
  try {
    const { stdout } = await runCompose(file, ['ps', '--format', 'json'], project);
    const text = stdout.trim();
    if (!text) return [];
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    }
  } catch {
    return [];
  }
}

export async function listComposeProjects(): Promise<ComposeProject[]> {
  await mkdir(config.composeRoot, { recursive: true });
  const files = await findComposeFiles(config.composeRoot);
  return Promise.all(
    files.map(async (file) => {
      const directory = relative(config.composeRoot, dirname(file)).split(sep).join('/');
      const fallback = composeProjectName(directory);
      let savedName = fallback;
      try {
        const metadata = JSON.parse(
          await readFile(join(dirname(file), '.nasdocker.json'), 'utf8'),
        ) as { project?: string };
        if (metadata.project && /^[a-z0-9][a-z0-9_-]*$/.test(metadata.project)) {
          savedName = metadata.project;
        }
      } catch {
        // Existing Compose directories do not have NasDocker metadata yet.
      }
      const services = await composePs(file, savedName);
      const discoveredName = String(services[0]?.Project || savedName);
      const states = services.map((service) => String(service.State || '').toLowerCase());
      const running = states.filter((state) => state === 'running').length;
      return {
        name: discoveredName,
        directory,
        file,
        services: services.map((service) => String(service.Service || service.Name || 'unknown')),
        status: running === 0 ? 'stopped' : running === states.length ? 'running' : 'partial',
      };
    }),
  );
}

export async function findComposeProject(name: string) {
  return (await listComposeProjects()).find((project) => project.name === name) || null;
}

export async function composeAction(
  name: string,
  action: 'start' | 'stop' | 'restart' | 'down' | 'pull-up',
) {
  const project = await findComposeProject(name);
  if (!project) throw new ComposeError('Compose 项目不存在', 404, 'PROJECT_NOT_FOUND');
  const commands: Record<typeof action, string[]> = {
    start: ['start'],
    stop: ['stop'],
    restart: ['restart'],
    down: ['down'],
    'pull-up': ['pull'],
  };
  await runCompose(project.file, commands[action], project.name);
  if (action === 'pull-up') {
    await runCompose(project.file, ['up', '-d', '--remove-orphans'], project.name);
  }
  return { project: project.name, action };
}
