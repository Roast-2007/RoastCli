/**
 * 蜂群 + worktree 端到端：worker 在独立 worktree 中写文件（主工作区不受影响），report 后由 Queen merge_worktree 合并；
 * worker 按绝对路径改原仓库被守卫拒绝；只读角色共享工作区；收尾时删除无改动的 worktree。
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createSession } from '../../src/agent/session.js';
import type { RoastConfig } from '../../src/core/config.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import { RoutedProvider } from '../fixtures/routed-provider.js';
import { textScript, toolCallScript } from '../fixtures/chunks.js';
import { tempWorkspace } from '../fixtures/workspace.js';
import type { Script } from '../fixtures/scripted-provider.js';

const config: RoastConfig = {
  providers: { p: { driver: 'openai-compat', apiKeyEnv: 'UNUSED' } },
  default: 'p:m',
  maxSteps: 10,
  logsDir: '.roast/logs',
  debugLog: false,
  context: {},
  swarm: { maxAgents: 12, maxDepth: 3, maxMinutes: 60 },
};

function gitRepo() {
  const ws = tempWorkspace('roast-wts-');
  const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: ws.dir, encoding: 'utf8' });
  git('init', '-q');
  ws.file('.gitignore', '.roast/\n');
  ws.file('src/app.ts', 'export const app = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return ws;
}

async function runSwarm(dir: string, scripts: Record<string, Script[]>) {
  const providers = new ProviderRegistry();
  const provider = new RoutedProvider(scripts);
  providers.register('p', provider);
  const session = await createSession({ cwd: dir, config, providers, permissionMode: 'yolo' });
  for await (const _ of session.loop.run('开始'));
  await session.swarm.whenIdle();
  return { session, provider };
}

const toolResultOf = (provider: RoutedProvider, agent: string, index: number) =>
  JSON.stringify(provider.requests.filter((r) => r.agent === agent)[index]?.req.messages.at(-1));

describe('swarm worktree isolation', () => {
  it('requires explicit shell approval in a worktree even in yolo mode', async () => {
    const ws = gitRepo();
    const command = `cd "${ws.dir.replaceAll('\\', '/')}" && printf escaped > escaped.txt`;
    const { session, provider } = await runSwarm(ws.dir, {
      main: [toolCallScript('s', 'spawn_agent', { role: 'worker', task: 'try shell escape' }), toolCallScript('a', 'await_agents', {}), textScript('done')],
      w1: [toolCallScript('b', 'bash', { command }), toolCallScript('r', 'report', { status: 'done', summary: 'blocked' }), textScript('done')],
    });
    expect(toolResultOf(provider, 'w1', 1)).toContain('授权');
    expect(existsSync(path.join(ws.dir, 'escaped.txt'))).toBe(false);
    await session.shutdown();
  }, 30_000);

  it('shutdown returns the paths of unmerged changes and releases their ownership', async () => {
    const ws = gitRepo();
    const { session } = await runSwarm(ws.dir, {
      main: [toolCallScript('s', 'spawn_agent', { role: 'worker', task: 'write a feature' }), toolCallScript('a', 'await_agents', {}), textScript('done')],
      w1: [toolCallScript('w', 'write', { path: 'feature.ts', content: 'keep' }), toolCallScript('r', 'report', { status: 'done', summary: 'ready' }), textScript('done')],
    });
    const root = session.swarm.info('w1')!.worktree!;
    expect(await session.shutdown()).toEqual({ worktrees: [root] });
    expect(readFileSync(path.join(root, 'feature.ts'), 'utf8')).toBe('keep');
  }, 30_000);

  it('worker edits in its own worktree; the queen merges after the report', async () => {
    const ws = gitRepo();
    const { session, provider } = await runSwarm(ws.dir, {
      main: [
        toolCallScript('s', 'spawn_agent', { role: 'worker', task: '新增 feature.ts' }),
        toolCallScript('a', 'await_agents', {}),
        toolCallScript('m', 'merge_worktree', { agentId: 'w1' }),
        textScript('已合并'),
      ],
      w1: [
        toolCallScript('x', 'write', { path: path.join(ws.dir, 'src', 'evil.ts'), content: 'no' }),
        toolCallScript('w', 'write', { path: 'src/feature.ts', content: 'export const feature = true;\n' }),
        toolCallScript('r', 'report', { status: 'done', summary: '加了 feature.ts' }),
        textScript('完成'),
      ],
    });

    expect(toolResultOf(provider, 'w1', 1)).toContain('不能直接修改原仓库文件');
    expect(existsSync(path.join(ws.dir, 'src', 'evil.ts'))).toBe(false);
    expect(toolResultOf(provider, 'main', 2)).toContain('merge_worktree');
    expect(toolResultOf(provider, 'main', 3)).toContain('已把 w1 的改动合并到你的工作区（1 个文件）');
    expect(readFileSync(path.join(ws.dir, 'src', 'feature.ts'), 'utf8')).toBe('export const feature = true;\n');
    expect(session.swarm.info('w1')?.worktree).toBeUndefined();
    await session.shutdown();
  }, 30_000);

  it('read-only roles share the workspace; unchanged worktrees are removed on shutdown', async () => {
    const ws = gitRepo();
    const { session } = await runSwarm(ws.dir, {
      main: [
        toolCallScript('s1', 'spawn_agent', { role: 'scout', task: '看看 app.ts' }),
        toolCallScript('s2', 'spawn_agent', { role: 'worker', task: '什么都不改' }),
        toolCallScript('a', 'await_agents', {}),
        textScript('好'),
      ],
      s1: [toolCallScript('r', 'report', { status: 'done', summary: '看过了' }), textScript('完成')],
      w2: [toolCallScript('r', 'report', { status: 'done', summary: '无改动' }), textScript('完成')],
    });

    expect(session.swarm.info('s1')?.worktree).toBeUndefined();
    const wt = session.swarm.info('w2')?.worktree;
    expect(wt && existsSync(wt)).toBe(true);
    await session.shutdown();
    expect(existsSync(wt!)).toBe(false);
  }, 30_000);

  it('falls back to a shared workspace outside git repositories', async () => {
    const ws = tempWorkspace('roast-wts-nogit-');
    const { session } = await runSwarm(ws.dir, {
      main: [toolCallScript('s', 'spawn_agent', { role: 'worker', task: '写文件' }), toolCallScript('a', 'await_agents', {}), textScript('好')],
      w1: [toolCallScript('w', 'write', { path: 'out.txt', content: 'hi' }), toolCallScript('r', 'report', { status: 'done', summary: '写好了' }), textScript('完成')],
    });
    expect(session.swarm.info('w1')?.worktree).toBeUndefined();
    expect(readFileSync(path.join(ws.dir, 'out.txt'), 'utf8')).toBe('hi');
    await session.shutdown();
  }, 30_000);
});

describe('worktree read access (M8 review M5)', () => {
  it('only this run\'s worktrees are readable without asking', async () => {
    const ws = tempWorkspace();
    const providers = new ProviderRegistry();
    providers.register('p', new RoutedProvider({}));
    const session = await createSession({ cwd: ws.dir, config, providers });
    const home = process.env['ROAST_HOME']!;
    const req = (target: string) => ({ tool: 'read', kind: 'read' as const, target, cwd: ws.dir, args: {} });
    const mine = path.join(home, 'worktrees', session.log.header.runId, 'w1', 'a.ts');
    const other = path.join(home, 'worktrees', 'some-other-run', 'w1', 'a.ts');
    expect(session.permissions.evaluate(req(mine)).behavior).toBe('allow');
    expect(session.permissions.evaluate(req(other)).behavior).toBe('ask');
    await session.shutdown();
  });
});
