/**
 * 蜂群策略模板：内置模板、YAML 自定义模板（信任规则）、/swarm 命令、best-of-N 的合并与丢弃、worktree 免审批读取。
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { buildSwarmPrompt, describeTemplates, loadTemplates, renderTemplate } from '../../src/swarm/templates.js';
import { createSession } from '../../src/agent/session.js';
import type { RoastConfig } from '../../src/core/config.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import { createUiController } from '../../src/ui/controller.js';
import { createUiStore } from '../../src/ui/store/store.js';
import { PermissionEngine } from '../../src/tools/permissions/engine.js';
import { RoutedProvider } from '../fixtures/routed-provider.js';
import { ScriptedProvider } from '../fixtures/scripted-provider.js';
import { textScript, toolCallScript } from '../fixtures/chunks.js';
import { tempWorkspace } from '../fixtures/workspace.js';

const config: RoastConfig = {
  providers: { p: { driver: 'openai-compat', apiKeyEnv: 'UNUSED' } },
  default: 'p:m',
  maxSteps: 10,
  logsDir: '.roast/logs',
  debugLog: false,
  context: {},
  swarm: { maxAgents: 12, maxDepth: 3, maxMinutes: 60 },
};

describe('swarm templates', () => {
  it('preserves literal dollar sequences and placeholders inside the goal', () => {
    const t = { name: 't', description: '', source: 'builtin' as const, prompt: '{{goal}} / {{n}} / {{ goal }}' };
    const goal = "keep $& $$ $` $' $1 and {{n}} / {{goal}}";
    expect(renderTemplate(t, goal, 4)).toBe(`${goal} / 4 / ${goal}`);
  });

  it('ships fanout, best-of-n, critique and research with goal and n substitution', () => {
    const templates = loadTemplates(tempWorkspace().dir, tempWorkspace().dir);
    expect([...templates.keys()]).toEqual(['fanout', 'best-of-n', 'critique', 'research']);
    const text = buildSwarmPrompt(templates, '实现 LRU 缓存', 'best-of-n', 4);
    expect(text).toContain('派出 4 个 worker');
    expect(text).toContain('目标：实现 LRU 缓存');
    expect(text).toContain('discard: true');
    expect(describeTemplates(templates, 5)).toContain('best-of-n  5 个 worker');
    expect(() => buildSwarmPrompt(templates, 'x', 'nope')).toThrow('未知的蜂群模板 nope');
  });

  it('loads YAML templates; untrusted projects cannot override existing names', () => {
    const home = tempWorkspace('roast-tpl-home-');
    const ws = tempWorkspace();
    home.file('templates/docs.yaml', 'description: 写文档\nprompt: 请派 scout 调研后写文档');
    ws.file('.roast/templates/fanout.yml', 'prompt: EVIL {{goal}}');
    ws.file('.roast/templates/triage.yaml', 'name: triage\ndescription: 分诊\nprompt: "分诊：{{goal}}，派 {{n}} 个 scout"');
    ws.file('.roast/templates/broken.yaml', 'prompt: [unclosed');

    const untrusted = loadTemplates(ws.dir, home.dir);
    expect(untrusted.get('fanout')?.source).toBe('builtin');
    expect(renderTemplate(untrusted.get('docs')!, 'API')).toBe('请派 scout 调研后写文档\n\n目标：API');
    expect(renderTemplate(untrusted.get('triage')!, 'bug', 2)).toBe('分诊：bug，派 2 个 scout');
    expect(untrusted.has('broken')).toBe(false);
    expect(loadTemplates(ws.dir, home.dir, { trusted: true }).get('fanout')?.prompt).toBe('EVIL {{goal}}');
  });
});

describe('/swarm command', () => {
  it('opens the strategy panel without arguments and sends the rendered instruction otherwise', async () => {
    const ws = tempWorkspace();
    const provider = new ScriptedProvider([textScript('收到')]);
    const providers = new ProviderRegistry();
    providers.register('p', provider);
    const session = await createSession({ cwd: ws.dir, config, providers });
    const store = createUiStore({ frameMs: 1 });
    const controller = createUiController(session, store, { exit: () => {} });
    const items = () => (store.flush(), store.getState().agents['main']!.items);

    controller.submit('/swarm', '/swarm');
    await new Promise((r) => setTimeout(r, 20));
    expect(store.getState().meta.overlay).toBe('swarm');

    controller.submit('/swarm best-of-n 实现 LRU', '/swarm best-of-n 实现 LRU');
    for (let i = 0; i < 100 && provider.requests.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    const sent = JSON.stringify(provider.requests[0]!.messages[0]);
    expect(sent).toContain('best-of-N');
    expect(sent).toContain('目标：实现 LRU');
    controller.dispose();
    await session.shutdown();
  });
});

describe('best-of-N merge and discard', () => {
  it('merges the winner and discards the loser, removing its worktree', async () => {
    const ws = tempWorkspace('roast-bon-');
    const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: ws.dir });
    git('init', '-q');
    ws.file('.gitignore', '.roast/\n');
    ws.file('a.ts', 'export const a = 0;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    const providers = new ProviderRegistry();
    providers.register(
      'p',
      new RoutedProvider({
        main: [
          toolCallScript('s1', 'spawn_agent', { role: 'worker', task: '把 a 改成 1' }),
          toolCallScript('s2', 'spawn_agent', { role: 'worker', task: '把 a 改成 1' }),
          toolCallScript('aw', 'await_agents', { mode: 'all' }),
          toolCallScript('m', 'merge_worktree', { agentId: 'w1' }),
          toolCallScript('d', 'merge_worktree', { agentId: 'w2', discard: true }),
          textScript('w1 胜出'),
        ],
        w1: [toolCallScript('e', 'write', { path: 'lru.ts', content: 'export const v = 1;\n' }), toolCallScript('r', 'report', { status: 'done', summary: '方案一' }), textScript('完成')],
        w2: [toolCallScript('e', 'write', { path: 'lru.ts', content: 'export const v = 2;\n' }), toolCallScript('r', 'report', { status: 'done', summary: '方案二' }), textScript('完成')],
      }),
    );
    const session = await createSession({ cwd: ws.dir, config, providers, permissionMode: 'yolo' });
    for await (const _ of session.loop.run('best of n'));
    await session.swarm.whenIdle();

    expect(readFileSync(path.join(ws.dir, 'lru.ts'), 'utf8')).toBe('export const v = 1;\n');
    expect(session.swarm.info('w2')?.worktree).toBeUndefined();
    await session.shutdown();
  }, 30_000);

  it('lets reviewers read swarm worktrees without asking', () => {
    const root = path.join(tempWorkspace().dir, 'worktrees');
    const engine = new PermissionEngine({ allow: [], ask: [], deny: [], mode: 'default', readRoots: [root] });
    const req = (target: string) => ({ tool: 'read', kind: 'read' as const, target, cwd: '/project', args: {} });
    expect(engine.evaluate(req(path.join(root, 'r', 'w1', 'a.ts'))).behavior).toBe('allow');
    expect(engine.evaluate(req(path.join(path.dirname(root), 'elsewhere.ts'))).behavior).toBe('ask');
    expect(existsSync(root)).toBe(false);
  });
});
