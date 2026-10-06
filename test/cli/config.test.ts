import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tempWorkspace } from '../fixtures/workspace.js';
import { readCredential } from '../../src/core/credentials.js';

function cli(args: string[], input?: string) {
  const home = tempWorkspace();
  const workspace = tempWorkspace();
  const env: NodeJS.ProcessEnv = { ...process.env, ROAST_HOME: home.dir };
  delete env['ROASTCLI_CONFIG'];
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href, fileURLToPath(new URL('../../src/entrypoints/cli.ts', import.meta.url)), ...args], {
    cwd: workspace.dir, env, input, encoding: 'utf8', timeout: 15_000, windowsHide: true,
  });
  return { result, home };
}

// A case can start two tsx processes (15s each); allow cold starts on Windows CI.
describe('config CLI entrypoint', { timeout: 35_000 }, () => {
  it('advertises the wizard without needing config or credentials', () => {
    const { result } = cli(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('终端内供应商配置向导');
    expect(result.stdout).toContain('update');
    expect(cli(['config', '--help']).result.status).toBe(0);
  });

  it('advertises the updater without configuration and supports a check-only option', () => {
    const { result, home } = cli(['update', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--check');
    expect(existsSync(join(home.dir, 'config.json'))).toBe(false);
  });

  it('refuses a noninteractive wizard without writing files', () => {
    const { result, home } = cli(['config']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('需要交互终端');
    expect(existsSync(join(home.dir, 'config.json'))).toBe(false);
    expect(existsSync(join(home.dir, 'credentials.json'))).toBe(false);
  });

  it('keeps missing-config errors for print mode and recommends the wizard', () => {
    const { result, home } = cli(['-p', 'hello']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('roast config');
    expect(result.stdout).not.toContain('\x1b');
    expect(existsSync(join(home.dir, 'config.json'))).toBe(false);
  });

  it('accepts a Kimi Code API key from stdin and persists effort without printing the key', () => {
    const { result, home } = cli(['init', '--provider', 'kimi-code', '--api-key-stdin', '--reasoning-effort', 'max'], 'sk-from-stdin\n');
    expect(result.status).toBe(0);
    const config = JSON.parse(readFileSync(join(home.dir, 'config.json'), 'utf8'));
    expect(config.default).toBe('kimi-code:kimi-for-coding');
    expect(config.providers['kimi-code'].models['kimi-for-coding'].reasoningEffort).toBe('max');
    expect(readCredential(home.dir, config.providers['kimi-code'].apiKeyRef)).toBe('sk-from-stdin');
    expect(result.stdout + result.stderr + JSON.stringify(config)).not.toContain('sk-from-stdin');
  });

  it('rejects empty stdin keys and invalid effort before writing either file', () => {
    for (const [effort, key] of [['max', '\n'], ['minimal', 'fake-key']] as const) {
      const { result, home } = cli(['init', '--provider', 'kimi-code', '--api-key-stdin', '--reasoning-effort', effort], key);
      expect(result.status).toBe(1);
      expect(existsSync(join(home.dir, 'config.json'))).toBe(false);
      expect(existsSync(join(home.dir, 'credentials.json'))).toBe(false);
    }
  });
});
