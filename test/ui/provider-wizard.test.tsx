import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, cleanup } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderWizard } from '../../src/ui/providers/ProviderWizard.js';
import { loadConfig, resolveApiKey } from '../../src/core/config.js';
import { tempWorkspace } from '../fixtures/workspace.js';

const savedEnv = { home: process.env['ROAST_HOME'], config: process.env['ROASTCLI_CONFIG'] };
let home: ReturnType<typeof tempWorkspace>;
let workspace: ReturnType<typeof tempWorkspace>;
beforeEach(() => {
  home = tempWorkspace(); workspace = tempWorkspace(); process.env['ROAST_HOME'] = home.dir; delete process.env['ROASTCLI_CONFIG'];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const [name, value] of [['ROAST_HOME', savedEnv.home], ['ROASTCLI_CONFIG', savedEnv.config]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 40));
async function waitForFrame(screen: { lastFrame(): string | undefined }, text: string) {
  const until = Date.now() + 3000;
  while (!screen.lastFrame()?.includes(text) && Date.now() < until) await tick();
  expect(screen.lastFrame()).toContain(text);
}
const enter = '\r';
const escape = '\x1b';
const down = '\x1b[B';
async function keys(stdin: { write(text: string): void }, ...inputs: string[]) {
  for (const input of inputs) { stdin.write(input); await tick(); }
}

// Full-form walkthroughs render many frames; hosted runners with coverage can exceed the default 5s.
describe('ProviderWizard', { timeout: 20_000 }, () => {
  it('automatically discovers a blank model, selects multiple IDs and saves only the selected metadata', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init: RequestInit) => new Response(JSON.stringify({ data: [{ id: 'alpha', context_window: 16000 }, { id: 'beta' }, { id: 'unselected' }] })));
    vi.stubGlobal('fetch', fetchMock);
    const screen = render(<ProviderWizard cwd={workspace.dir} onExit={() => {}} />);
    await tick(); await keys(screen.stdin, enter, enter, enter, enter, '\x15', enter);
    await keys(screen.stdin, 'sk-list-secret', enter);
    expect(screen.lastFrame()).toContain('模型列表');
    expect(fetchMock.mock.calls[0]![1].headers).toHaveProperty('authorization', 'Bearer sk-list-secret');
    await keys(screen.stdin, down, enter); await waitForFrame(screen, '[x] alpha');
    await keys(screen.stdin, down, enter); await waitForFrame(screen, '[x] beta');
    await keys(screen.stdin, '\x1b[H', enter); await waitForFrame(screen, '3 / 4 · 配置凭据');
    await keys(screen.stdin, enter); await waitForFrame(screen, '确认并保存');
    await keys(screen.stdin, enter); await waitForFrame(screen, '保存成功');
    const config = loadConfig(workspace.dir)!;
    expect(config.default).toBe('deepseek:alpha');
    expect(config.providers['deepseek']!.models).toEqual({ alpha: { contextWindow: 16000 }, beta: {} });
    expect(screen.frames.join('\n')).not.toContain('sk-list-secret');
  });
  it('guides setup, masks keys in every frame and persists a usable profile', async () => {
    const onExit = vi.fn();
    const { stdin, lastFrame, frames } = render(<ProviderWizard cwd={workspace.dir} onExit={onExit} />);
    await tick();
    await keys(stdin, enter, enter); // Add, then DeepSeek.
    expect(lastFrame()).toContain('连接与模型');
    await keys(stdin, enter, enter, enter); // Connection fields.
    expect(lastFrame()).toContain('API Key');
    expect(lastFrame()).not.toContain('环境变量');
    await keys(stdin, 'sk-wizard-secret', enter);
    expect(lastFrame()).toContain('确认并保存');
    expect(frames.join('\n')).not.toContain('sk-wizard-secret');
    await keys(stdin, enter);
    expect(lastFrame()).toContain('保存成功');
    // Long temporary paths can wrap the message differently on macOS.
    expect(lastFrame()!.replace(/\s+/g, '')).toContain('下一次启动生效');
    const config = loadConfig(workspace.dir)!;
    expect(config.default).toBe('deepseek:deepseek-chat');
    expect(resolveApiKey(config.providers['deepseek']!, 'deepseek')).toBe('sk-wizard-secret');
    expect(readFileSync(join(home.dir, 'config.json'), 'utf8')).not.toContain('sk-wizard-secret');
    await keys(stdin, escape);
    expect(onExit).toHaveBeenCalledWith(true);
  });

  it('migrates old credentials while editing and selecting the default model', async () => {
    home.file('config.json', JSON.stringify({ providers: { p: { driver: 'anthropic', apiKeyEnv: 'ANTHROPIC_KEY', models: { old: {} } }, other: { driver: 'openai-compat', apiKeyEnv: 'OTHER' } }, default: 'other:other-model' }));
    const { stdin, lastFrame } = render(<ProviderWizard cwd={workspace.dir} onExit={() => {}} />);
    await tick();
    await keys(stdin, down, enter, enter, enter, '\x15', 'new-model', enter);
    await keys(stdin, 'new-api-key', '\t', '\x1b[C', '\t', '\x1b[C', enter);
    expect(lastFrame()).toContain('默认模型：p:new-model');
    expect(lastFrame()).toContain('Reasoning effort：low');
    await keys(stdin, enter);
    expect(loadConfig(workspace.dir)!.default).toBe('p:new-model');
    expect(loadConfig(workspace.dir)!.providers['p']!.models).toHaveProperty('old');
    expect(resolveApiKey(loadConfig(workspace.dir)!.providers['p']!, 'p')).toBe('new-api-key');
    expect(loadConfig(workspace.dir)!.providers['p']!.apiKeyEnv).toBeUndefined();
    expect(loadConfig(workspace.dir)!.providers['p']!.models!['new-model']!.reasoningEffort).toBe('low');
  });

  it('rejects empty keys, permits returning to edit and cancels without files', async () => {
    const onExit = vi.fn();
    const { stdin, lastFrame } = render(<ProviderWizard cwd={workspace.dir} onExit={onExit} />);
    await tick();
    await keys(stdin, enter, enter, enter, enter, enter, enter);
    expect(lastFrame()).toContain('请输入 API Key');
    await keys(stdin, escape);
    expect(lastFrame()).toContain('连接与模型');
    await keys(stdin, escape, escape, escape);
    expect(onExit).toHaveBeenCalledWith(false);
    expect(existsSync(join(home.dir, 'config.json'))).toBe(false);
    expect(existsSync(join(home.dir, 'credentials.json'))).toBe(false);
  });

  it('reports save errors without exposing a key and allows retry', async () => {
    const { stdin, lastFrame, frames } = render(<ProviderWizard cwd={workspace.dir} onExit={() => {}} />);
    await tick();
    await keys(stdin, enter, enter, enter, enter, enter, 'retry-secret', enter);
    home.file('credentials.json', '{broken-secret');
    await keys(stdin, enter);
    expect(lastFrame()).toContain('无法读取凭据文件');
    expect(lastFrame()).toContain('确认并保存');
    home.file('credentials.json', '{}');
    await keys(stdin, enter);
    expect(lastFrame()).toContain('保存成功');
    expect(frames.join('\n')).not.toContain('retry-secret');
    expect(frames.join('\n')).not.toContain('broken-secret');
  });

  it('preserves fast key input and saves a Kimi Code profile through the complete form', async () => {
    const { stdin, lastFrame, frames } = render(<ProviderWizard cwd={workspace.dir} onExit={() => {}} />);
    await tick();
    await keys(stdin, enter);
    // Kimi Code follows the existing Kimi / Moonshot preset.
    await keys(stdin, down, down, down, down, enter);
    expect(lastFrame()).toContain('api.kimi.com/coding/v1');
    for (let i = 0; i < 3; i++) stdin.write(enter);
    await waitForFrame({ lastFrame }, '3 / 4 · 配置凭据');
    for (const character of 'sk-kimi-fast-input') stdin.write(character);
    await tick();
    await keys(stdin, '\t', '\x1b[D'); // Kimi Code: auto → max.
    stdin.write(enter); stdin.write(enter);
    await waitForFrame({ lastFrame }, '保存成功');
    const config = loadConfig(workspace.dir)!;
    expect(config.default).toBe('kimi-code:kimi-for-coding');
    expect(resolveApiKey(config.providers['kimi-code']!, 'kimi-code')).toBe('sk-kimi-fast-input');
    expect(config.providers['kimi-code']!.models!['kimi-for-coding']!.reasoningEffort).toBe('max');
    expect(frames.join('\n')).not.toContain('sk-kimi-fast-input');
  });
});
