import { constants } from 'node:fs';
import { open, mkdir, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { AxiError, object } from './errors.js';
import { normalizeHost } from './http.js';

export interface Config { host: string; project?: string; key?: string; auth: 'environment' | 'file' | 'none'; }
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'posthog-axi', 'config.json');
}
function missing(e: unknown): boolean { return object(e).code === 'ENOENT'; }

export async function readConfig(path: string): Promise<Record<string, unknown>> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new AxiError('insecure_config', 'Credential file must be a regular file with mode 0600', ['chmod 600 ~/.config/posthog-axi/config.json']);
    const data: unknown = JSON.parse(await file.readFile('utf8'));
    const value = object(data);
    if (typeof value.host !== 'string' || typeof value.project !== 'string' || typeof value.key !== 'string') throw new Error('invalid');
    return value;
  } catch (e) {
    if (missing(e)) return {};
    if (e instanceof AxiError) throw e;
    throw new AxiError('config_error', 'Could not read credential file; expected private JSON with host, project and key');
  } finally { await file?.close(); }
}

export async function resolveConfig(overrides: { host?: string; project?: string } = {}, env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  // A complete environment key takes precedence without reading stale disk credentials.
  const saved = env.POSTHOG_API_KEY ? {} : await readConfig(configPath(env));
  const host = normalizeHost(overrides.host ?? env.POSTHOG_HOST ?? String(saved.host ?? 'https://us.posthog.com'));
  const project = overrides.project ?? env.POSTHOG_PROJECT_ID ?? (saved.project as string | undefined);
  if (project !== undefined && !/^\d+$/.test(project)) throw new AxiError('invalid_project', 'Project must be a numeric ID');
  const fileKey = saved.host && normalizeHost(String(saved.host)) === host ? String(saved.key) : undefined;
  const key = env.POSTHOG_API_KEY || fileKey;
  return { host, project, key, auth: env.POSTHOG_API_KEY ? 'environment' : fileKey ? 'file' : 'none' };
}

export async function saveConfig(path: string, config: { host: string; project: string; key: string }): Promise<void> {
  const host = normalizeHost(config.host);
  if (!config.key.trim() || /\s/.test(config.key) || !/^\d+$/.test(config.project)) throw new AxiError('invalid_config', 'Expected a personal key without whitespace and a numeric project ID');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(JSON.stringify({ ...config, host }) + '\n');
    await file.sync();
    await file.close(); file = undefined;
    await rename(temporary, path);
  } finally {
    await file?.close();
    await unlink(temporary).catch((e: unknown) => { if (!missing(e)) throw e; });
  }
}

export async function logout(path: string): Promise<void> {
  await unlink(path).catch((e: unknown) => { if (!missing(e)) throw new AxiError('config_error', 'Could not remove credential file'); });
}

function requireTerminal(input: { isTTY?: boolean }, output: { isTTY?: boolean }): void {
  if (!input.isTTY || !output.isTTY) throw new AxiError('tty_required', 'Login needs a terminal for hidden input', ['For automation, set POSTHOG_API_KEY and POSTHOG_PROJECT_ID; never pass keys as command arguments.']);
}
export async function promptLine(question: string, input = process.stdin, output = process.stderr): Promise<string> {
  requireTerminal(input, output);
  const rl = createInterface({ input, output });
  try { return await rl.question(question); } finally { rl.close(); }
}
export function promptKey(input = process.stdin, output = process.stderr): Promise<string> {
  requireTerminal(input, output);
  return new Promise((resolve, reject) => {
    let value = '';
    const wasRaw = input.isRaw;
    const finish = (error?: AxiError) => {
      input.off('data', data); input.off('end', end); input.off('error', end);
      input.setRawMode(wasRaw); input.pause(); output.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const end = () => finish(new AxiError('cancelled', 'Login input closed'));
    const data = (chunk: Buffer) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\u0003' || ch === '\u0004') return finish(new AxiError('cancelled', 'Login cancelled'));
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ' && ch <= '~') value += ch;
      }
    };
    output.write('Personal API key (hidden): '); input.setRawMode(true); input.resume();
    input.on('data', data); input.once('end', end); input.once('error', end);
  });
}
