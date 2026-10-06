/**
 * App 集成：真实会话（脚本化 provider）+ ink-testing-library。
 * 覆盖：横幅、用户消息与 markdown 回答、写文件的权限卡片 → 允许 → 工具卡片带 diff、状态栏、斜杠命令。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSession, type Session } from '../../src/agent/session.js';
import type { RoastConfig } from '../../src/core/config.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import { App } from '../../src/ui/App.js';
import { ScriptedProvider, type Script } from '../fixtures/scripted-provider.js';
import { textScript, toolCallScript } from '../fixtures/chunks.js';
import { tempWorkspace } from '../fixtures/workspace.js';

const saved = process.env['ROAST_HOME'];
beforeEach(() => {
  process.env['ROAST_HOME'] = tempWorkspace('roast-app-home-').dir;
});
afterEach(() => {
  if (saved === undefined) delete process.env['ROAST_HOME'];
  else process.env['ROAST_HOME'] = saved;
});

const config: RoastConfig = {
  providers: { p: { driver: 'openai-compat', apiKeyEnv: 'UNUSED' } },
  default: 'p:m',
  maxSteps: 10,
  logsDir: 'logs',
  debugLog: false,
  context: {},
  swarm: { maxAgents: 12, maxDepth: 3, maxMinutes: 60 },
};

async function makeSession(scripts: Script[]): Promise<{ session: Session; dir: string }> {
  const ws = tempWorkspace('roast-app-');
  const providers = new ProviderRegistry();
  providers.register('p', new ScriptedProvider(scripts));
  const session = await createSession({ cwd: ws.dir, config, providers });
  return { session, dir: ws.dir };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check: () => boolean, ms = 3000, frame?: () => string | undefined): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return;
    await sleep(30);
  }
  throw new Error(`等待超时${frame ? `，最后一帧：\n${frame()}` : ''}`);
}

describe('App', () => {
  it('F1 opens help while preserving the editor draft', async () => {
    const { session } = await makeSession([]);
    const screen = render(<App session={session} />);
    try {
      await sleep(40); screen.stdin.write('unsent draft'); await sleep(40);
      screen.stdin.write('\u001bOP'); await sleep(50);
      expect(screen.lastFrame()).toContain('帮助 · ROAST');
      screen.stdin.write('\u001b'); await sleep(60);
      expect(screen.lastFrame()).toContain('unsent draft');
      expect(session.loop.committer.messages()).toEqual([]);
    } finally { screen.unmount(); await session.shutdown(); }
  });
  it('横幅 → 提问 → markdown 回答 → 回合小结', async () => {
    const { session } = await makeSession([textScript('# 结论\n\n一切**正常**。')]);
    const { stdin, lastFrame, frames, unmount } = render(<App session={session} />);
    await sleep(50);
    expect(frames.join('\n')).toContain('ROAST');
    stdin.write('你好');
    await sleep(30);
    stdin.write('\r');
    await waitFor(() => frames.join('\n').includes('用时'));
    const all = frames.join('\n');
    expect(all).toContain('你好');
    expect(all).toContain('结论');
    expect(all).toContain('正常');
    expect(lastFrame()).toContain('默认');
    unmount();
    await session.shutdown();
  });

  it('写文件：权限卡片 → 按 1 允许 → 工具卡片显示 diff 统计，文件写入', { timeout: 30_000 }, async () => {
    const { session, dir } = await makeSession([toolCallScript('w1', 'write', { path: 'hello.txt', content: 'hi\n' }), textScript('写好了')]);
    const { stdin, frames, lastFrame, unmount } = render(<App session={session} />);
    await sleep(50);
    stdin.write('写个文件');
    await sleep(30);
    stdin.write('\r');
    await waitFor(() => frames.join('\n').includes('需要你的授权'), 3000, lastFrame);
    await sleep(50);
    stdin.write('1');
    // 首次检查点需要 git init，Windows 上较慢
    await waitFor(() => frames.join('\n').includes('写好了'), 15_000, lastFrame);
    const all = frames.join('\n');
    expect(all).toContain('write');
    expect(all).toContain('+1 -0');
    expect(existsSync(path.join(dir, 'hello.txt'))).toBe(true);
    expect(readFileSync(path.join(dir, 'hello.txt'), 'utf8')).toBe('hi\n');
    unmount();
    await session.shutdown();
  });

  it('斜杠命令：/context 输出占用，未知命令给出提示', async () => {
    const { session } = await makeSession([]);
    const { stdin, frames, unmount } = render(<App session={session} />);
    await sleep(50);
    stdin.write('/context');
    await sleep(30);
    stdin.write('\r');
    await waitFor(() => frames.join('\n').includes('上下文'));
    stdin.write('\u001b');
    await sleep(50);
    stdin.write('/nope');
    await sleep(30);
    stdin.write('\r');
    await waitFor(() => frames.join('\n').includes('未知命令'));
    unmount();
    await session.shutdown();
  });

  it('Ctrl+O 打开最近工具的完整输出；空闲时双击 Esc 打开回退列表', async () => {
    const { session, dir } = await makeSession([toolCallScript('l', 'ls', { path: '.' }), textScript('看完了')]);
    const { stdin, lastFrame, frames, unmount } = render(<App session={session} />);
    await sleep(50);
    stdin.write('看看目录');
    await sleep(30);
    stdin.write('\r');
    await waitFor(() => frames.join('\n').includes('看完了'));
    stdin.write('\u000f');
    await waitFor(() => lastFrame()!.includes('Ctrl+O 关闭'), 3000, lastFrame);
    expect(lastFrame()).toContain('logs');
    stdin.write('\u000f');
    await waitFor(() => !lastFrame()!.includes('Ctrl+O 关闭'), 3000, lastFrame);

    stdin.write('\u001b');
    await sleep(80);
    stdin.write('\u001b');
    await waitFor(() => frames.join('\n').includes('可回退的轮次'), 3000, lastFrame);
    expect(existsSync(dir)).toBe(true);
    unmount();
    await session.shutdown();
  });
});
