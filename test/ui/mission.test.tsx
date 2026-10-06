/**
 * Mission Control：真实蜂群会话跑完后渲染指挥台，验证 agent 树、选中 agent 的输出、消息时间线、黑板与按键。
 */
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession } from '../../src/agent/session.js';
import type { RoastConfig } from '../../src/core/config.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import { createUiController } from '../../src/ui/controller.js';
import { agentLines, treeOrder, windowLines } from '../../src/ui/hive/lines.js';
import { Deck as MissionControl } from '../../src/ui/hive/Deck.js';
import { createUiStore } from '../../src/ui/store/store.js';
import { RoutedProvider } from '../fixtures/routed-provider.js';
import { textScript, toolCallScript } from '../fixtures/chunks.js';
import { tempWorkspace } from '../fixtures/workspace.js';

const saved = process.env['ROAST_HOME'];
beforeEach(() => {
  process.env['ROAST_HOME'] = tempWorkspace('roast-mc-home-').dir;
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Mission Control', () => {
  it('one page down moves immediately after repeated scrolling at the top', async () => {
    const providers = new ProviderRegistry();
    providers.register('p', new RoutedProvider({ main: [textScript(Array.from({ length: 100 }, (_, i) => `line-${i}`).join('\n'))] }));
    const session = await createSession({ cwd: tempWorkspace().dir, config, providers });
    const store = createUiStore({ frameMs: 1 });
    const controller = createUiController(session, store, { exit: () => {} });
    controller.submit('long output', 'long output');
    await session.loop.whenIdle();
    store.flush();
    const { stdin, lastFrame, unmount } = render(<MissionControl session={session} store={store} controller={controller} onExit={() => {}} />);
    try {
      await sleep(50);
      stdin.write('\x1b[17~'); await sleep(20); stdin.write('\x1b[17~'); await sleep(20); stdin.write('2'); await sleep(20);
      for (let i = 0; i < 20; i++) {
        stdin.write('b');
        await sleep(15);
      }
      const topLine = Number(/line-(\d+)/.exec(lastFrame()!)?.[1]);
      expect(topLine).toBe(0);
      stdin.write('f');
      await sleep(50);
      const nextLine = Number(/line-(\d+)/.exec(lastFrame()!)?.[1]);
      expect(nextLine).toBeGreaterThan(topLine);
    } finally {
      unmount();
      controller.dispose();
      await session.shutdown();
    }
  });

  it('显示 agent 树、选中 agent 的输出、消息与黑板；j 切换选中，q 返回', async () => {
    const ws = tempWorkspace('roast-mc-');
    const providers = new ProviderRegistry();
    providers.register(
      'p',
      new RoutedProvider({
        main: [toolCallScript('s', 'spawn_agent', { role: 'scout', task: '调研登录模块' }), toolCallScript('a', 'await_agents', {}), textScript('总结完毕')],
        s1: [toolCallScript('b', 'board_write', { key: '/mission/login', value: '使用 JWT' }), toolCallScript('r', 'report', { status: 'done', summary: '登录用 JWT' }), textScript('结束')],
      }),
    );
    const session = await createSession({ cwd: ws.dir, config, providers });
    const store = createUiStore({ frameMs: 1 });
    const controller = createUiController(session, store, { exit: () => {} });
    controller.submit('调研一下', '调研一下');
    for (let i = 0; i < 100 && !(store.getState().meta.running === false && store.getState().agents['main']!.items.length > 2); i++) await sleep(30);
    await session.swarm.whenIdle();
    await sleep(150);
    store.flush();

    const onExit = vi.fn();
    const { lastFrame, stdin, unmount } = render(<MissionControl session={session} store={store} controller={controller} onExit={onExit} />);
    await sleep(50);
    const frame = lastFrame()!;
    expect(frame).toContain('ROAST HIVE');
    expect(frame).toContain('queen [queen]');
    expect(frame).toContain('s1 [scout]');
    stdin.write('\x1b[17~'); await sleep(30);
    stdin.write('6');
    await sleep(30);
    expect(lastFrame()).toContain('/mission/login');
    stdin.write('5');
    await sleep(30);
    expect(lastFrame()).toContain('[report]');
    stdin.write('2');
    await sleep(30);
    stdin.write('j');
    await sleep(50);
    expect(lastFrame()).toContain('board_write');
    stdin.write('\u0007');
    await sleep(30);
    expect(onExit).toHaveBeenCalled();
    unmount();
    controller.dispose();
    await session.shutdown();
  }, 30_000);
});

describe('mission lines', () => {
  it('treeOrder 深度优先；agentLines 无输出时给出占位', () => {
    const a = (id: string, parentId: string | null, depth: number) => ({ id, parentId, depth, role: 'worker' as const, state: 'running' as const, brief: '', model: 'm', startedAt: 0, children: [] });
    expect(treeOrder([a('main', null, 0), a('w2', 'main', 1), a('w1', 'main', 1), a('w3', 'w1', 2)]).map((x) => x.id)).toEqual(['main', 'w2', 'w1', 'w3']);
    expect(agentLines(undefined)[0]!.text).toContain('还没有输出');
  });
});

describe('windowLines', () => {
  it('follows the tail by default and scrolls up without passing the top', () => {
    const lines = Array.from({ length: 10 }, (_, i) => ({ text: `l${i}`, tone: 'text' as const }));
    expect(windowLines(lines, 3, 0).shown.map((l) => l.text)).toEqual(['l7', 'l8', 'l9']);
    expect(windowLines(lines, 3, 4).shown.map((l) => l.text)).toEqual(['l3', 'l4', 'l5']);
    expect(windowLines(lines, 3, 99)).toMatchObject({ offset: 7, shown: [{ text: 'l0' }, { text: 'l1' }, { text: 'l2' }] });
    expect(windowLines(lines.slice(0, 2), 5, 3)).toMatchObject({ offset: 0 });
  });
});
