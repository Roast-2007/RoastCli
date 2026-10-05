import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectChecks, renderChecks } from '../../src/cli/doctor.js';
import { draftFromProfile, providerOverrideWarnings, readProviderSettings, saveProviderSettings, validateProviderDraft, type ProviderDraft } from '../../src/cli/provider-settings.js';
import { loadConfig, resolveApiKey, trustProject, trustState, untrustedProviderOverrides } from '../../src/core/config.js';
import { readCredential } from '../../src/core/credentials.js';
import { PROVIDER_PRESETS } from '../../src/providers/presets.js';
import { tempWorkspace } from '../fixtures/workspace.js';

const savedEnv = { home: process.env['ROAST_HOME'], config: process.env['ROASTCLI_CONFIG'], key: process.env['ROAST_WIZARD_KEY'] };
let home: ReturnType<typeof tempWorkspace>;
let workspace: ReturnType<typeof tempWorkspace>;
beforeEach(() => {
  home = tempWorkspace(); workspace = tempWorkspace();
  process.env['ROAST_HOME'] = home.dir;
  delete process.env['ROASTCLI_CONFIG']; delete process.env['ROAST_WIZARD_KEY'];
});
afterEach(() => {
  for (const [name, value] of [['ROAST_HOME', savedEnv.home], ['ROASTCLI_CONFIG', savedEnv.config], ['ROAST_WIZARD_KEY', savedEnv.key]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

const draft = (overrides: Partial<ProviderDraft> = {}): ProviderDraft => ({ name: 'p', driver: 'openai-compat', baseURL: 'https://example.com/v1', model: 'model-a', apiKey: 'sk-local-test', makeDefault: true, ...overrides });

describe('provider settings and credentials', () => {
  it('adds multiple custom models, retains inherited metadata and supports explicit no-key interfaces', () => {
    saveProviderSettings(workspace.dir, draft({ model: 'one, two, one', reasoningEffort: 'high', modelMeta: { two: { contextWindow: 32000 } } }));
    let config = loadConfig(workspace.dir)!;
    expect(config.default).toBe('p:one'); expect(Object.keys(config.providers['p']!.models!)).toEqual(['one', 'two']);
    workspace.file('.roast/config.json', JSON.stringify({ providers: { p: { models: { one: { maxTokens: 4000 } } } } }));
    const edit = draftFromProfile('p', readProviderSettings(workspace.dir).providers['p']!, 'p:one');
    saveProviderSettings(workspace.dir, { ...edit, model: 'one, three' });
    config = loadConfig(workspace.dir)!;
    expect(config.providers['p']!.models!.one).toMatchObject({ reasoningEffort: 'high', maxTokens: 4000 });
    expect(config.providers['p']!.models!.two).toMatchObject({ contextWindow: 32000 });
    saveProviderSettings(workspace.dir, draft({ name: 'local', baseURL: 'http://localhost:1234/v1', model: 'local-a, local-b', apiKey: '', auth: 'none' }));
    config = loadConfig(workspace.dir)!;
    expect(resolveApiKey(config.providers['local']!, 'local')).toBe('');
    expect(validateProviderDraft(draft({ model: 'good, __proto__' }))).toBeTruthy();
  });
  it('saves reloadable API keys and ignores legacy environment variables; doctor never echoes secrets', async () => {
    const result = saveProviderSettings(workspace.dir, draft());
    const config = loadConfig(workspace.dir)!;
    expect(config.default).toBe('p:model-a');
    expect(readFileSync(result.file, 'utf8')).not.toContain('sk-local-test');
    expect(resolveApiKey(config.providers['p']!, 'p')).toBe('sk-local-test');
    process.env['ROAST_WIZARD_KEY'] = 'sk-env-test';
    expect(resolveApiKey({ ...config.providers['p']!, apiKeyEnv: 'ROAST_WIZARD_KEY' }, 'p')).toBe('sk-local-test');
    expect(config.providers['p']!.apiKeyEnv).toBeUndefined();
    delete process.env['ROAST_WIZARD_KEY'];
    const report = renderChecks(await collectChecks(workspace.dir));
    expect(report).toContain('用户凭据文件 已设置');
    expect(report).not.toContain('sk-local-test');
    if (process.platform !== 'win32') expect(statSync(join(home.dir, 'credentials.json')).mode & 0o777).toBe(0o600);
  });

  it('preserves extensions, other providers and model metadata; key rotation leaves the old profile usable', () => {
    home.file('config.json', JSON.stringify({ providers: { p: { driver: 'openai-compat', apiKeyEnv: 'OLD', models: { 'model-a': { reasoningReplay: 'field' } }, headers: { 'x-custom': 'yes' } }, other: { driver: 'anthropic', apiKeyEnv: 'OTHER' } }, default: 'other:model-b', hooks: { Stop: [{ command: 'echo done' }] }, mcp: { servers: {} }, custom: { enabled: true } }));
    saveProviderSettings(workspace.dir, draft({ makeDefault: false }));
    const old = loadConfig(workspace.dir)!.providers['p']!;
    const edit = draftFromProfile('p', old, 'other:model-b');
    saveProviderSettings(workspace.dir, { ...edit, apiKey: 'sk-rotated', makeDefault: true });
    const current = loadConfig(workspace.dir)!;
    expect(current.providers['p']!.models!['model-a']!.reasoningReplay).toBe('field');
    expect(current.providers['p']!.headers).toEqual({ 'x-custom': 'yes' });
    expect(current.providers['other']!.driver).toBe('anthropic');
    expect(resolveApiKey(old, 'p')).toBe('sk-local-test');
    expect(resolveApiKey(current.providers['p']!, 'p')).toBe('sk-rotated');
    expect(current.providers['p']!.apiKeyRef).not.toBe(old.apiKeyRef);
    expect(JSON.parse(readFileSync(join(home.dir, 'config.json'), 'utf8'))).toMatchObject({ hooks: { Stop: [{ command: 'echo done' }] }, custom: { enabled: true } });
    saveProviderSettings(workspace.dir, draftFromProfile('p', current.providers['p']!, current.default));
    expect(loadConfig(workspace.dir)!.providers['p']!.apiKeyRef).toBe(current.providers['p']!.apiKeyRef);
  });

  it('migrates env-only profiles by requiring an API key and removes the deprecated field', () => {
    home.file('config.json', JSON.stringify({ providers: { p: { driver: 'openai-compat', apiKeyEnv: 'ROAST_WIZARD_KEY', models: { 'model-a': {} } } }, default: 'p:model-a' }));
    const settings = readProviderSettings(workspace.dir);
    process.env['ROAST_WIZARD_KEY'] = 'env-only';
    expect(() => resolveApiKey(settings.providers['p']!, 'p')).toThrow('API Key');
    const edit = draftFromProfile('p', settings.providers['p']!);
    expect(() => saveProviderSettings(workspace.dir, edit)).toThrow('API Key');
    saveProviderSettings(workspace.dir, { ...edit, apiKey: 'explicit-key' });
    const profile = loadConfig(workspace.dir)!.providers['p']!;
    expect(profile.apiKeyEnv).toBeUndefined();
    expect(resolveApiKey(profile, 'p')).toBe('explicit-key');
  });

  it('warns about higher priority files and treats reference changes as trust changes', () => {
    saveProviderSettings(workspace.dir, draft());
    workspace.file('.roast/config.json', JSON.stringify({ providers: { p: { apiKeyRef: 'project-ref', models: { 'model-c': {} } } }, default: 'p:model-c' }));
    expect(providerOverrideWarnings(workspace.dir, 'p', true)[0]).toContain('.roast');
    expect(readProviderSettings(workspace.dir).providers['p']!.models).toHaveProperty('model-a');
    expect(readProviderSettings(workspace.dir).default).toBe('p:model-c');
    expect(readProviderSettings(workspace.dir).userDefault).toBe('p:model-a');
    expect(untrustedProviderOverrides(workspace.dir)).toContain('p');
    trustProject(workspace.dir);
    expect(trustState(workspace.dir)).toBe('trusted');
    workspace.file('.roast/config.json', JSON.stringify({ providers: { p: { apiKeyRef: 'changed-ref' } } }));
    expect(trustState(workspace.dir)).toBe('changed');
  });

  it('validates before writing; malformed credentials are neither exposed nor overwritten', () => {
    expect(validateProviderDraft(draft({ name: '__proto__' }))).toBeTruthy();
    expect(validateProviderDraft(draft({ baseURL: 'https://user:secret@example.com' }))).toBeTruthy();
    expect(validateProviderDraft(draft({ model: '' }))).toContain('模型 ID');
    expect(() => saveProviderSettings(workspace.dir, draft({ apiKey: '' }))).toThrow('API Key');
    expect(existsSync(join(home.dir, 'config.json'))).toBe(false);
    home.file('credentials.json', '{sk-sensitive-malformed');
    expect(() => saveProviderSettings(workspace.dir, draft())).toThrow('无法读取凭据文件');
    expect(() => readCredential(home.dir, 'ref')).not.toThrow('sk-sensitive');
    expect(readFileSync(join(home.dir, 'credentials.json'), 'utf8')).toBe('{sk-sensitive-malformed');
    expect(existsSync(join(home.dir, 'config.json'))).toBe(false);
  });

  it('updates the effective project config so saved models and keys survive reloading', () => {
    workspace.file('roastcli.config.json', JSON.stringify({ providers: { project: { driver: 'openai-compat', apiKeyEnv: 'PROJECT_KEY' } }, default: 'project:model' }));
    const result = saveProviderSettings(workspace.dir, draft({ baseURL: ' https://example.com/v1/ ' }));
    expect(result.file).toBe(join(workspace.dir, 'roastcli.config.json'));
    expect(loadConfig(workspace.dir)!.default).toBe('p:model-a');
    expect(resolveApiKey(loadConfig(workspace.dir)!.providers['p']!, 'p')).toBe('sk-local-test');
    expect(readFileSync(result.file, 'utf8')).not.toContain('sk-local-test');
    expect(result.warnings.join('\n')).toContain('roast trust');
  });

  it('saves into a partial project overlay while preserving inherited metadata and other settings', () => {
    saveProviderSettings(workspace.dir, draft());
    workspace.file('.roast/config.json', JSON.stringify({ providers: { p: { models: { extra: { contextWindow: 8000 } } } }, ui: { theme: 'aurora' } }));
    const edit = draftFromProfile('p', readProviderSettings(workspace.dir).providers['p']!, 'p:model-a');
    const result = saveProviderSettings(workspace.dir, { ...edit, model: 'new-model', apiKey: 'new-key' });
    const reloaded = loadConfig(workspace.dir)!;
    expect(result.file).toBe(join(workspace.dir, '.roast', 'config.json'));
    expect(reloaded.default).toBe('p:new-model');
    expect(reloaded.ui?.theme).toBe('aurora');
    expect(reloaded.providers['p']!.models).toHaveProperty('extra');
    expect(resolveApiKey(reloaded.providers['p']!, 'p')).toBe('new-key');
  });

  it('round-trips model effort and removes an explicit override when returning to automatic', () => {
    saveProviderSettings(workspace.dir, draft({ reasoningEffort: 'high' }));
    const profile = loadConfig(workspace.dir)!.providers['p']!;
    const edit = draftFromProfile('p', profile, 'p:model-a');
    expect(edit.reasoningEffort).toBe('high');
    saveProviderSettings(workspace.dir, { ...edit, reasoningEffort: undefined });
    const reloaded = loadConfig(workspace.dir)!.providers['p']!;
    expect(reloaded.models!['model-a']!.reasoningEffort).toBeUndefined();
    expect(reloaded.apiKeyRef).toBe(profile.apiKeyRef);
    saveProviderSettings(workspace.dir, { ...edit, reasoningEffort: 'high' });
    workspace.file('.roast/config.json', JSON.stringify({ ui: { theme: 'mono' } }));
    const inherited = readProviderSettings(workspace.dir).providers['p']!;
    saveProviderSettings(workspace.dir, { ...draftFromProfile('p', inherited, 'p:model-a'), reasoningEffort: undefined });
    expect(loadConfig(workspace.dir)!.providers['p']!.models!['model-a']!.reasoningEffort).toBeUndefined();
  });

  it('keeps the prior config usable if replacing its file fails', () => {
    // A directory in place of config.json forces a genuine filesystem failure, with no mocking.
    mkdirSync(join(home.dir, 'config.json'));
    expect(() => saveProviderSettings(workspace.dir, draft())).toThrow('无法读取配置');
    expect(existsSync(join(home.dir, 'credentials.json'))).toBe(false);
  });

  it('provides all mainstream presets and both custom protocols without requiring model discovery', () => {
    expect(Object.keys(PROVIDER_PRESETS)).toEqual(expect.arrayContaining(['deepseek', 'qwen', 'zhipu', 'kimi', 'kimi-code', 'doubao', 'hunyuan', 'siliconflow', 'openai', 'anthropic', 'gemini', 'openrouter', 'custom', 'custom-anthropic']));
    expect(PROVIDER_PRESETS['kimi-code']).toMatchObject({ baseURL: 'https://api.kimi.com/coding/v1', model: 'kimi-for-coding', driver: 'openai-compat' });
    expect(PROVIDER_PRESETS['doubao']!.model).toBe('');
    for (const preset of Object.values(PROVIDER_PRESETS).filter((p) => p.model)) {
      expect(validateProviderDraft(draft({ name: preset.name, driver: preset.driver, baseURL: preset.baseURL, model: preset.model }))).toBeUndefined();
    }
    home.file('config.json', JSON.stringify({ providers: { p: { driver: 'openai-compat' } }, default: 'p:m' }));
    expect(() => resolveApiKey(loadConfig(workspace.dir)!.providers['p']!, 'p')).toThrow('API Key');
  });
});
