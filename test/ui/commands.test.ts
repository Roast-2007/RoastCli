/**
 * 斜杠命令：经真实控制器执行，断言写入 store 的提示。
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createSession } from '../../src/agent/session.js';
import type { RoastConfig } from '../../src/core/config.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import { createUiController } from '../../src/ui/controller.js';
import { appendMemory, findCommand } from '../../src/ui/commands.js';
import { createUiStore } from '../../src/ui/store/store.js';
import { ScriptedProvider } from '../fixtures/scripted-provider.js';
import { tempWorkspace } from '../fixtures/workspace.js';

const config: RoastConfig = {
  providers: { p: { driver: 'openai-compat', apiKeyEnv: 'UNUSED' } },
  default: 'p:m',
  maxSteps: 10,
  logsDir: 'logs',
  debugLog: false,
  context: {},
  swarm: { maxAgents: 12, maxDepth: 3, maxMinutes: 60 },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function harness() {
  const ws = tempWorkspace('roast-cmd-');
  const providers = new ProviderRegistry();
  providers.register('p', new ScriptedProvider([]));
  const session = await createSession({ cwd: ws.dir, config, providers });
  const store = createUiStore({ frameMs: 1 });
  let exited = false;
  const controller = createUiController(session, store, { exit: () => (exited = true) });
  const run = async (line: string) => {
    controller.submit(line, line);
    await sleep(20);
    store.flush();
    const items = store.getState().agents['main']!.items;
    const last = items.at(-1);
    return last?.kind === 'notice' ? last.text : '';
  };
  const done = async () => {
    controller.dispose();
    await session.shutdown();
  };
  return { ws, session, store, run, done, exited: () => exited };
}

describe('slash commands', () => {
  it('help, model, cost, todo, logs, context, mcp', async () => {
    const h = await harness();
    await h.run('/help');
    expect(h.store.getState().meta.overlay).toBe('help');
    expect(await h.run('/model')).toBe('p:m');
    expect(await h.run('/cost')).toContain('输入 0');
    expect(await h.run('/todo')).not.toBe('');
    expect(await h.run('/logs')).toBe(h.session.log.path);
    await h.run('/context');
    expect(h.store.getState().meta.overlay).toBe('context');
    expect(await h.run('/mcp')).toContain('没有配置 MCP 服务器');
    expect(await h.run('/skills')).toContain('没有技能');
    expect(await h.run('/config')).toContain('roast config');
    expect(await h.run('/agents')).toContain('main [queen]');
    expect(await h.run('/board')).toContain('黑板为空');
    h.session.swarm.board.write('/example', 'complete value', { author: 'main' });
    expect(await h.run('/board /example')).toContain('complete value');
    expect(await h.run('/board /missing')).toContain('没有黑板条目');
    await h.done();
  });

  it('mode switches, cycles and rejects unknown modes', async () => {
    const h = await harness();
    expect(await h.run('/mode plan')).toBe('权限模式：plan');
    expect(h.session.permissions.mode).toBe('plan');
    expect(await h.run('/mode')).toMatch(/^权限模式：/);
    expect(await h.run('/mode nope')).toBe('未知模式：nope');
    await h.done();
  });

  it('rewind lists nothing on a fresh session and validates its argument', async () => {
    const h = await harness();
    expect(await h.run('/rewind')).toBe('还没有可回退的轮次');
    expect(await h.run('/rewind abc')).toBe('用法：/rewind 或 /rewind N');
    expect(await h.run('/rewind 3')).toContain('/rewind 失败：当前历史中没有第 3 轮');
    await h.done();
  });

  it('init creates ROAST.md once; # notes append to its memory section', async () => {
    const h = await harness();
    expect(await h.run('/init')).toContain('已创建');
    expect(await h.run('/init')).toContain('已存在');
    expect(await h.run('#偏好 pnpm')).toContain('已记住');
    const file = path.join(h.ws.dir, 'ROAST.md');
    expect(readFileSync(file, 'utf8')).toContain('## 记忆\n- 偏好 pnpm');
    await h.done();
  });

  it('exit and its alias call the exit callback', async () => {
    const h = await harness();
    await h.run('/quit');
    expect(h.exited()).toBe(true);
    expect(findCommand('exit')?.name).toBe('exit');
    await h.done();
  });
});

describe('appendMemory', () => {
  it('creates the file and section when missing, and keeps existing content', () => {
    const ws = tempWorkspace();
    const file = appendMemory(ws.dir, ' 第一条 ');
    expect(readFileSync(file, 'utf8')).toBe('## 记忆\n- 第一条\n');
    ws.file('ROAST.md', '# 项目\n\n说明');
    appendMemory(ws.dir, '第二条');
    expect(readFileSync(file, 'utf8')).toBe('# 项目\n\n说明\n\n## 记忆\n- 第二条\n');
    expect(existsSync(file)).toBe(true);
  });
});
