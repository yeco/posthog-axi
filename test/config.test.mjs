import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveConfig, readConfig, resolveConfig, configPath, logout, promptKey } from '../dist/config.js';
test('private atomic login, precedence and host binding', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'posthog-axi-'));
  try {
    const env = { XDG_CONFIG_HOME: dir }; const path = configPath(env);
    await saveConfig(path, { host: 'https://us.posthog.com', project: '613011', key: 'phx_fake' });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).key, 'phx_fake');
    assert.equal((await resolveConfig({}, env)).auth, 'file');
    assert.equal((await resolveConfig({ host: 'https://eu.posthog.com' }, env)).key, undefined);
    assert.equal((await resolveConfig({ project: '1' }, { ...env, POSTHOG_API_KEY: 'override' })).key, 'override');
    await chmod(path, 0o644); await assert.rejects(readConfig(path), { code: 'insecure_config' });
    await logout(path); await logout(path);
    await symlink('/dev/null', path); await assert.rejects(readConfig(path), { code: 'config_error' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('noninteractive login refuses visible input', () => {
  assert.throws(() => promptKey({ isTTY: false }, { isTTY: false }), { code: 'tty_required' });
});
