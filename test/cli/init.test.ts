import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { initConfig } from '../../src/cli/init.js';
import { loadConfig, resolveApiKey } from '../../src/core/config.js';
import { tempWorkspace } from '../fixtures/workspace.js';

const saved = process.env['ROAST_HOME'];
let home: ReturnType<typeof tempWorkspace>;
beforeEach(() => {
  home = tempWorkspace('roast-init-home-');
  process.env['ROAST_HOME'] = home.dir;
});
afterEach(() => {
  if (saved === undefined) delete process.env['ROAST_HOME'];
  else process.env['ROAST_HOME'] = saved;
});

describe('roast init', () => {
  it('writes a loadable config and directs users to enter an API key', () => {
    const ws = tempWorkspace();
    const { file, text } = initConfig(ws.dir);
    expect(file).toBe(path.join(home.dir, 'config.json'));
    expect(text).toContain('roast config');
    expect(text).not.toContain('API_KEY');
    expect(loadConfig(ws.dir)?.default).toBe('deepseek:deepseek-chat');
    expect(readFileSync(file, 'utf8')).not.toMatch(/sk-/);
  });

  it('persists a supplied API key for Kimi Code without embedding it in config or output', () => {
    const ws = tempWorkspace();
    const { file, text } = initConfig(ws.dir, { provider: 'kimi-code', apiKey: 'sk-kimi-stdin' });
    const config = loadConfig(ws.dir)!;
    expect(config.default).toBe('kimi-code:kimi-for-coding');
    expect(resolveApiKey(config.providers['kimi-code']!, 'kimi-code')).toBe('sk-kimi-stdin');
    expect(readFileSync(file, 'utf8') + text).not.toContain('sk-kimi-stdin');
  });

  it('supports other providers, model override, project scope and refuses to overwrite without --force', () => {
    const ws = tempWorkspace();
    const { file, text } = initConfig(ws.dir, { provider: 'anthropic', model: 'claude-opus-5-5', project: true });
    expect(file).toBe(path.join(ws.dir, '.roast', 'config.json'));
    expect(text).toContain('roast trust');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ default: 'claude:claude-opus-5-5', providers: { claude: { driver: 'anthropic' } } });

    expect(() => initConfig(ws.dir, { project: true })).toThrow('已存在');
    expect(initConfig(ws.dir, { project: true, provider: 'openai', force: true }).text).toContain('openai:gpt-5');
    expect(() => initConfig(ws.dir, { provider: 'nope' })).toThrow('未知 provider');
  });
});
