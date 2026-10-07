import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigSchema,
  configSources,
  loadConfig,
  mergeConfigLayer,
  roastHome,
  untrustedProviderOverrides,
  trustProject,
  trustState,
} from '../../src/core/config.js';
import { RoastError } from '../../src/core/errors.js';
import { tempWorkspace } from '../fixtures/workspace.js';

let home: string;
let cwd: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ['ROAST_HOME', 'ROASTCLI_CONFIG']) saved[k] = process.env[k];
  home = tempWorkspace('roast-home-').dir;
  cwd = tempWorkspace('roast-proj-').dir;
  process.env['ROAST_HOME'] = home;
  delete process.env['ROASTCLI_CONFIG'];
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value), 'utf8');
}

const ds = { driver: 'openai-compat', apiKeyEnv: 'DEEPSEEK_API_KEY', models: { 'deepseek-chat': { contextWindow: 1000 } } };

describe('分层配置', () => {
  it('主会话和子 agent 的默认预算与配置互相独立', () => {
    const base = { providers: { p: { driver: 'openai-compat' } }, default: 'p:m' };
    expect(ConfigSchema.parse(base)).toMatchObject({ maxSteps: 100, swarm: { maxSteps: 150 } });
    expect(ConfigSchema.parse({ ...base, maxSteps: 2, swarm: { maxSteps: 7 } })).toMatchObject({ maxSteps: 2, swarm: { maxSteps: 7 } });
    for (const maxSteps of [0, -1, 1.5]) expect(ConfigSchema.safeParse({ ...base, swarm: { maxSteps } }).success).toBe(false);
  });
  it('terminal notifications and title can only come from the user layer, even for trusted projects', () => {
    writeJson(path.join(home, 'config.json'), { providers: { p: { driver: 'openai-compat' } }, default: 'p:m' });
    writeJson(path.join(cwd, '.roast/config.json'), { ui: { notify: 'bell', title: false, home: 'chat' } });
    trustProject(cwd);
    expect(loadConfig(cwd)!.ui).toMatchObject({ home: 'chat' });
    expect(loadConfig(cwd)!.ui!.notify).toBe('auto');
    expect(loadConfig(cwd)!.ui!.title).toBe(true);
    const base = mergeConfigLayer({}, { ui: { notify: 'off', title: false } }, 'user');
    for (const layer of ['project', 'legacy', 'env'] as const)
      expect(mergeConfigLayer(base, { ui: { notify: 'bell', title: true } }, layer)).toMatchObject({ ui: { notify: 'off', title: false } });
  });
  it('requires trust for repository search endpoints and invalidates trust when they change', () => {
    writeJson(path.join(home, 'config.json'), { providers: { p: { driver: 'openai-compat' } }, default: 'p:m' });
    const file = path.join(cwd, '.roast/config.json');
    writeJson(file, { webSearch: { driver: 'searxng', baseURL: 'https://first.example/search', apiKeyRef: 'key' } });
    expect(loadConfig(cwd)!.webSearch).toBeUndefined();
    trustProject(cwd);
    expect(loadConfig(cwd)!.webSearch?.baseURL).toBe('https://first.example/search');
    writeJson(file, { webSearch: { driver: 'searxng', baseURL: 'https://changed.example/search', apiKeyRef: 'key' } });
    expect(trustState(cwd)).toBe('changed');
    expect(loadConfig(cwd)!.webSearch).toBeUndefined();
  });
  it('没有任何配置文件返回 null', () => {
    expect(loadConfig(cwd)).toBeNull();
  });

  it('ROAST_HOME 决定用户级目录', () => {
    expect(roastHome()).toBe(home);
  });

  it('项目配置补充全局配置，全局设置优先生效', () => {
    writeJson(path.join(home, 'config.json'), { providers: { deepseek: ds }, default: 'deepseek:deepseek-chat', maxSteps: 10 });
    writeJson(path.join(cwd, '.roast', 'config.json'), {
      providers: { deepseek: { models: { 'deepseek-chat': { maxTokens: 99 } } } },
      maxSteps: 20,
    });
    writeJson(path.join(cwd, 'roastcli.config.json'), { logsDir: 'my-logs' });
    const config = loadConfig(cwd)!;
    expect(config.maxSteps).toBe(10);
    expect(config.logsDir).toBe('my-logs');
    expect(config.providers['deepseek']!.models!['deepseek-chat']).toEqual({ contextWindow: 1000, maxTokens: 99 });
    expect(
      configSources(cwd)
        .filter((s) => s.exists)
        .map((s) => s.layer),
    ).toEqual(['project', 'legacy', 'user']);
  });

  it('ROASTCLI_CONFIG 作为最高优先级层', () => {
    writeJson(path.join(home, 'config.json'), { providers: { deepseek: ds }, default: 'deepseek:deepseek-chat' });
    const explicit = path.join(cwd, 'explicit.json');
    writeJson(explicit, { maxSteps: 7 });
    process.env['ROASTCLI_CONFIG'] = explicit;
    expect(loadConfig(cwd)!.maxSteps).toBe(7);
  });

  it('全局默认模型、界面和 Hive 路由跨项目复用，项目只补充未设置的值', () => {
    writeJson(path.join(home, 'config.json'), {
      providers: { deepseek: ds },
      default: 'deepseek:deepseek-chat',
      ui: { theme: 'mono' },
      swarm: { models: { worker: 'deepseek:deepseek-chat' } },
    });
    writeJson(path.join(cwd, '.roast', 'config.json'), {
      default: 'deepseek:old',
      ui: { theme: 'aurora', markdown: { spacing: 2 } },
      swarm: { models: { worker: 'deepseek:old', scout: 'inherit' } },
    });
    expect(loadConfig(cwd)).toMatchObject({
      default: 'deepseek:deepseek-chat',
      ui: { theme: 'mono', markdown: { spacing: 2 } },
      swarm: { models: { worker: 'deepseek:deepseek-chat', scout: 'inherit' } },
    });
    expect(loadConfig(tempWorkspace().dir)).toMatchObject({ default: 'deepseek:deepseek-chat', ui: { theme: 'mono' } });
  });

  it('全局连接不继承仓库中的密钥引用、headers、URL 或认证方式', () => {
    writeJson(path.join(cwd, '.roast', 'config.json'), {
      providers: {
        p: {
          driver: 'anthropic',
          baseURL: 'https://repo.example',
          headers: { 'x-repo': 'yes' },
          apiKeyRef: 'repo-key',
          auth: 'none',
          models: { m: { contextWindow: 8000, maxTokens: 999 } },
        },
      },
      default: 'p:old',
    });
    writeJson(path.join(home, 'config.json'), {
      providers: { p: { driver: 'openai-compat', models: { m: { maxTokens: 100 } } } },
      default: 'p:m',
    });
    expect(loadConfig(cwd)!.providers.p).toEqual({ driver: 'openai-compat', models: { m: { contextWindow: 8000, maxTokens: 100 } } });
    expect(untrustedProviderOverrides(cwd)).toEqual([]);
    const explicit = path.join(cwd, 'explicit.json');
    writeJson(explicit, { providers: { p: { baseURL: 'https://explicit.example' } } });
    process.env['ROASTCLI_CONFIG'] = explicit;
    expect(loadConfig(cwd)!.providers.p!.baseURL).toBe('https://explicit.example');
    expect(untrustedProviderOverrides(cwd)).toEqual(['p']);
  });

  it('验证合并不修改将要持久化的全局配置对象', () => {
    const raw = { providers: { p: { driver: 'openai-compat', apiKeyRef: 'pending' } } };
    const merged = mergeConfigLayer({}, raw, 'user') as typeof raw;
    expect(merged.providers.p).not.toBe(raw.providers.p);
    raw.providers.p.apiKeyRef = 'saved-key';
    expect(raw.providers.p.apiKeyRef).toBe('saved-key');
    expect(merged.providers.p.apiKeyRef).toBe('pending');
  });

  it('合并后校验失败抛 CONFIG 错误并指出来源', () => {
    writeJson(path.join(cwd, '.roast', 'config.json'), { providers: {}, default: 'x:y' });
    expect(() => loadConfig(cwd)).toThrowError(RoastError);
  });

  it('非法 JSON 指出具体文件', () => {
    mkdirSync(path.join(cwd, '.roast'), { recursive: true });
    writeFileSync(path.join(cwd, '.roast', 'config.json'), '{oops', 'utf8');
    expect(() => loadConfig(cwd)).toThrowError(/\.roast/);
  });
});

describe('配置安全', () => {
  it('deepMerge 忽略 __proto__ / constructor / prototype 键', async () => {
    const { deepMerge } = await import('../../src/core/config.js');
    const evil = JSON.parse('{"__proto__":{"logsDir":"C:/evil"},"constructor":{"x":1},"maxSteps":3}');
    const merged = deepMerge({ logsDir: 'logs' }, evil) as Record<string, unknown>;
    expect(merged['logsDir']).toBe('logs');
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(merged['maxSteps']).toBe(3);
  });

  it('全局供应商屏蔽同名项目连接，项目独有的连接仍需信任', async () => {
    const { untrustedProviderOverrides } = await import('../../src/core/config.js');
    writeJson(path.join(home, 'config.json'), { providers: { deepseek: ds }, default: 'deepseek:deepseek-chat' });
    writeJson(path.join(cwd, '.roast', 'config.json'), {
      providers: { deepseek: { baseURL: 'https://evil.example' }, extra: { driver: 'openai-compat', apiKeyEnv: 'X' } },
      maxSteps: 3,
    });
    expect(untrustedProviderOverrides(cwd).sort()).toEqual(['extra']);
    expect(loadConfig(cwd)!.providers.deepseek!.baseURL).toBeUndefined();
  });

  it('项目层只改模型元数据不需要信任', async () => {
    const { untrustedProviderOverrides } = await import('../../src/core/config.js');
    writeJson(path.join(home, 'config.json'), { providers: { deepseek: ds }, default: 'deepseek:deepseek-chat' });
    writeJson(path.join(cwd, '.roast', 'config.json'), { providers: { deepseek: { models: { 'deepseek-chat': { maxTokens: 5 } } } } });
    expect(untrustedProviderOverrides(cwd)).toEqual([]);
  });

  it('trustProject 后该项目被信任', async () => {
    const { isProjectTrusted, trustProject } = await import('../../src/core/config.js');
    expect(isProjectTrusted(cwd)).toBe(false);
    trustProject(cwd);
    expect(isProjectTrusted(cwd)).toBe(true);
  });
});
