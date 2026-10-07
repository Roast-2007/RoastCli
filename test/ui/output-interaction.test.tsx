import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink';
import { App } from '../../src/ui/App.js';
import { Deck } from '../../src/ui/hive/Deck.js';
import { createSession, type Session } from '../../src/agent/session.js';
import { ConfigSchema } from '../../src/core/config.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import { createUiStore, type UiStore } from '../../src/ui/store/store.js';
import { createUiController } from '../../src/ui/controller.js';
import { deckLayout } from '../../src/ui/hive/layout.js';
import { paneMetrics } from '../../src/ui/hive/Pane.js';
import { viewport } from '../../src/ui/viewport.js';
import { displayWidth } from '../../src/core/text-width.js';
import { signalLines } from '../../src/ui/hive/SignalsPane.js';
import { loadStrategies, missionInput } from '../../src/swarm/strategies.js';
import type { EditorState } from '../../src/ui/input/editor.js';
import { ScriptedProvider } from '../fixtures/scripted-provider.js';
import { textScript, toolCallScript } from '../fixtures/chunks.js';
import { tempWorkspace } from '../fixtures/workspace.js';
import { deckFixture, Input, Terminal, tick } from './hive/fixture.js';

const press = (x: number, y: number, button = 0) => `\x1b[<${button};${x + 1};${y + 1}M`;
const markdown = (store: UiStore, text: string, agent = 'main') => {
  store.pushEvent(agent, { type: 'text-delta', text });
  store.pushEvent(agent, { type: 'stream-commit' });
  store.flush();
};
const tool = (store: UiStore, callId: string, path: string, done = true) => {
  store.pushEvent('main', { type: 'tool-call-start', callId, name: 'read', args: { path } });
  if (done)
    store.pushEvent('main', {
      type: 'tool-call-end',
      callId,
      name: 'read',
      isError: false,
      preview: `result ${path}`,
      output: `result ${path}`,
      durationMs: 2,
    });
  store.flush();
};
const lineAt = (tty: Terminal, text: string) => {
  const y = tty
    .frame()
    .split('\n')
    .findIndex((line) => line.includes(text));
  expect(y, tty.frame()).toBeGreaterThanOrEqual(0);
  return y;
};
const clickTwice = async (f: { send(text: string): Promise<void> }, x: number, y: number, button = 0) => {
  await f.send(press(x, y, button));
  await f.send(press(x, y, button));
};
async function appFixture(session?: Session, deck = false, columns = 100, rows = 26) {
  if (!session) {
    const providers = new ProviderRegistry();
    providers.register('p', new ScriptedProvider([]));
    session = await createSession({
      cwd: tempWorkspace().dir,
      providers,
      config: ConfigSchema.parse({
        providers: { p: { driver: 'openai-compat', auth: 'none' } },
        default: 'p:m',
        logsDir: 'logs',
        ui: { motion: 'reduced' },
        swarm: { worktrees: false },
      }),
    });
  }
  let printedUpTo = 0;
  const store = createUiStore(),
    controller = createUiController(session, store, {
      exit() {},
      clearScreen() {
        printedUpTo = store.getState().agents.main!.nextId - 1;
        instance.rerender(element());
      },
    });
  const tty = new Terminal(columns, rows),
    stdin = new Input(),
    draft: { seed?: number; state?: EditorState } = {};
  const element = () =>
    deck ? (
      <Deck session={session} store={store} controller={controller} inputDraft={draft} onExit={() => {}} />
    ) : (
      <App session={session} store={store} controller={controller} inputDraft={draft} printedUpTo={printedUpTo} fullScreen />
    );
  const instance = render(element(), {
    stdout: tty as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    interactive: true,
    alternateScreen: true,
    incrementalRendering: false,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  await tick();
  return {
    session,
    store,
    controller,
    tty,
    draft,
    instance,
    send: async (text: string) => {
      stdin.write(text);
      await tick();
      await instance.waitUntilRenderFlush();
    },
    close: async () => {
      instance.unmount();
      await instance.waitUntilExit();
      instance.cleanup();
      controller.dispose();
      await session.shutdown();
    },
  };
}

describe('富文本输出与任意工具的真实终端交互', () => {
  it('zooms a scrolled member pane, keeps its tab/member/offset on both exits and retains reading through resize', async () => {
    const f = await deckFixture();
    try {
      const root = f.store.getState().meta.swarm[0]!;
      f.store.setMeta({ swarm: [root, { ...root, id: 'w1', parentId: 'main', role: 'worker', depth: 1, state: 'done' }] });
      markdown(f.store, '# **渲染标题**\n\n' + Array.from({ length: 85 }, (_, i) => `成员行-${i}`).join('\n'), 'w1');
      await tick();
      await f.send('\x1b[17~');
      await f.send('j');
      await f.send('\r');
      await f.send('g');
      expect(f.tty.frame()).toContain('渲染标题');
      expect(f.tty.frame()).not.toContain('**');
      expect(f.tty.frame()).not.toContain('# **');
      const before = f.tty
        .frame()
        .split('\n')
        .find((line) => line.includes('已上翻'))!;
      const v = viewport(f.tty.columns, f.tty.rows),
        l = deckLayout(v.columns, v.rows),
        m = paneMetrics(l.mission, l.body);
      // 同窗格的不同坐标也属于一次双击。
      await f.send(press(l.colony + m.inset + 1, l.header + m.titleRow + 1));
      await f.send(press(l.colony + m.inset + 4, l.header + m.titleRow + 2));
      expect(f.tty.frame()).toContain('w1 worker · 输出 · done');
      expect(f.tty.frame()).not.toContain('已上翻');
      await f.send('g');
      expect(f.tty.frame()).toContain('成员行-0');
      f.tty.columns = 64;
      f.tty.rows = 25;
      f.tty.emit('resize');
      await tick(100);
      await f.instance.waitUntilRenderFlush();
      expect(f.tty.frame()).toContain('w1 worker · 输出');
      expect(f.tty.frame()).toContain('成员行-0');
      await f.send('\x1b');
      expect(f.tty.frame()).toContain('已上翻');
      expect(f.store.getState().focus).toBe('w1');
      f.tty.columns = 120;
      f.tty.rows = 40;
      f.tty.emit('resize');
      await tick(100);
      expect(f.tty.frame()).toContain(before.trim());
      await f.send('\r');
      expect(f.tty.frame()).toContain('w1 worker · 输出');
      await f.send('g');
      await clickTwice(f, 4, 2);
      expect(f.tty.frame()).toContain('已上翻');
      expect(f.store.getState().focus).toBe('w1');
    } finally {
      await f.close();
    }
  });
  it('opens the earlier tool in zoom and returns without losing its viewport or input draft', async () => {
    const f = await deckFixture(100, 26);
    try {
      tool(f.store, 'old', 'earlier.txt');
      markdown(f.store, '工具之间');
      tool(f.store, 'new', 'latest.txt');
      markdown(f.store, Array.from({ length: 50 }, (_, i) => `尾部-${i}`).join('\n'));
      await f.send('保留草稿');
      await f.send('\x1b[17~');
      await f.send('\t');
      await f.send('2');
      await f.send('\r');
      await f.send('g');
      const y = lineAt(f.tty, 'earlier.txt');
      await clickTwice(f, 5, y);
      expect(f.tty.frame()).toContain('工具 1/2');
      expect(f.tty.frame()).toContain('result earlier.txt');
      await f.send('\x1b[C');
      expect(f.tty.frame()).toContain('工具 2/2');
      expect(f.tty.frame()).toContain('result latest.txt');
      await f.send('\x1b');
      expect(f.tty.frame()).toContain('queen queen · 输出');
      expect(f.tty.frame()).toContain('earlier.txt');
      expect(f.draft.state?.lines.join('')).toBe('保留草稿');
      markdown(f.store, '新流式内容');
      await tick();
      expect(f.tty.frame()).toContain('earlier.txt');
      expect(f.tty.frame()).not.toContain('新流式内容');
      await f.send('G');
      expect(f.tty.frame()).toContain('新流式内容');
      markdown(f.store, '继续跟随');
      await tick();
      expect(f.tty.frame()).toContain('继续跟随');
      await f.send('中文');
      expect(f.draft.state?.lines.join('')).toBe('保留草稿中文');
    } finally {
      await f.close();
    }
  });
  it.each([64, 100])('supports output Enter at %i columns but does not enter zoom in compact height', async (columns) => {
    const f = await deckFixture(columns, 24);
    try {
      markdown(f.store, '**窄屏输出**');
      await f.send('\x1b[17~');
      await f.send('\t');
      await f.send('2');
      expect(f.tty.frame()).toContain('窄屏输出');
      await f.send('\r');
      expect(f.tty.frame()).toContain('queen queen · 输出');
      await f.send('\x1b');
      f.tty.rows = 7;
      f.tty.emit('resize');
      await tick(100);
      await f.send('\r');
      await clickTwice(f, 3, 1);
      expect(f.tty.frame()).not.toContain('queen queen · 输出');
    } finally {
      await f.close();
    }
  });
  it('Chat ignores selection clicks and mouse off, opens the exact tool and Ctrl+O chooses the last visible tool', async () => {
    const f = await appFixture();
    try {
      await f.send('draft');
      tool(f.store, 'old', 'earlier.txt');
      markdown(f.store, '间隔');
      tool(f.store, 'new', 'latest.txt');
      markdown(f.store, Array.from({ length: 50 }, (_, i) => `聊天行-${i}`).join('\n'));
      await tick();
      await f.send('\x1b[5~');
      await f.send('g');
      const y = lineAt(f.tty, 'earlier.txt');
      await clickTwice(f, 4, y, 4);
      expect(f.tty.frame()).not.toContain('工具 1/2');
      f.controller.runCommand('/mouse off');
      await tick();
      await clickTwice(f, 4, y);
      expect(f.tty.frame()).not.toContain('工具 1/2');
      f.controller.runCommand('/mouse on');
      await tick();
      await clickTwice(f, 0, y);
      expect(f.tty.frame()).not.toContain('工具 1/2');
      await clickTwice(f, 4, y);
      expect(f.tty.frame()).toContain('工具 1/2');
      expect(f.tty.frame()).toContain('result earlier.txt');
      await f.send('\x1b[C');
      expect(f.tty.frame()).toContain('工具 2/2');
      await f.send('\x1b');
      expect(f.tty.frame()).toContain('earlier.txt');
      expect(f.tty.frame()).toContain('阅读 · 1');
      await f.send('\x0f');
      expect(f.tty.frame()).toContain('工具 2/2');
      await f.send('\x0f');
      expect(f.tty.frame()).toContain('阅读 · 1');
      expect(f.draft.state?.lines.join('')).toBe('draft');
      // 最新工具在视口外时，Ctrl+O 仍选择可见的旧工具。
      f.store.pushEvent('main', { type: 'tool-call-start', callId: 'running', name: 'bash', args: { command: 'echo live' } });
      f.store.flush();
      await tick();
      await f.send('\x0f');
      expect(f.tty.frame()).toContain('工具 2/3');
      await f.send('\x0f');
      await f.send('G');
      await f.send('\x0f');
      expect(f.tty.frame()).toContain('工具 3/3');
      expect(f.tty.frame()).toContain('运行中');
      f.store.pushEvent('main', {
        type: 'tool-call-end',
        callId: 'running',
        name: 'bash',
        isError: false,
        preview: '最终结果',
        output: '最终结果',
        durationMs: 10,
      });
      f.store.flush();
      await tick();
      await f.instance.waitUntilRenderFlush();
      expect(f.tty.frame()).toContain('完成');
      expect(f.tty.frame()).toContain('最终结果');
    } finally {
      await f.close();
    }
  });
  it('pins update signals and deduplicates warnings while strategy chip hit width follows n visibility', async () => {
    const f = await deckFixture();
    try {
      f.controller.notify('可更新到 0.5.1');
      f.session.startupWarnings.push('启动警告');
      f.controller.notify('启动警告', 'warn');
      for (let i = 0; i < 60; i++) f.store.addNotice('main', `其他信号-${i}`);
      f.store.restore('main', []);
      for (let i = 0; i < 60; i++) f.store.addNotice('main', `其他信号-${i}`);
      await tick();
      expect(signalLines(f.session, f.store.getState()).filter((line) => line.text === '启动警告')).toHaveLength(1);
      const l = deckLayout(viewport(f.tty.columns, f.tty.rows).columns, viewport(f.tty.columns, f.tty.rows).rows);
      expect(f.tty.frame().split('\n')[l.header + paneMetrics(l.signals, l.body).titleRow + 1]).toContain('可更新到');
      for (const command of ['/strategy best-of-n 5', '/strategy critique']) {
        f.controller.runCommand(command);
        await tick();
        const chip = command.includes('best-of-n') ? '策略 best-of-n · n 5' : '策略 critique';
        const v = viewport(f.tty.columns, f.tty.rows);
        await vi.waitFor(() => expect(f.tty.frame()).toContain(chip));
        await f.send(press(v.columns - displayWidth(chip), l.header + l.body));
        expect(f.store.getState().meta.overlay).toBe('strategy');
        await f.send('\x1b');
      }
    } finally {
      await f.close();
    }
  });
  it.each([false, true])('restored Deck defaults to Queen output or a valid plan (plan=%s)', async (plan) => {
    const ws = tempWorkspace(),
      providers = new ProviderRegistry();
    providers.register(
      'p',
      new ScriptedProvider(
        plan
          ? [
              toolCallScript('plan', 'board_write', {
                key: '/mission/plan',
                value: JSON.stringify({ tasks: [{ id: 't1', title: '恢复计划', role: 'worker', acceptance: '可恢复', dependsOn: [] }] }),
              }),
              textScript('恢复 Queen 输出'),
            ]
          : [textScript('恢复 Queen 输出')],
      ),
    );
    const session = await createSession({
      cwd: ws.dir,
      providers,
      config: ConfigSchema.parse({
        providers: { p: { driver: 'openai-compat', auth: 'none' } },
        default: 'p:m',
        logsDir: 'logs',
        swarm: { worktrees: false },
      }),
    });
    for await (const _event of session.loop.run(missionInput(loadStrategies('', ''), '恢复目标', 'auto', 3))) {
      /* drain */
    }
    await session.shutdown();
    const resumed = await session.resume(session.log.path),
      f = await appFixture(resumed, true);
    try {
      expect(f.tty.frame()).toContain(plan ? '恢复计划' : '恢复 Queen 输出');
      expect(f.store.getState().focus).toBe('main');
    } finally {
      await f.close();
    }
  });
  it.each([false, true])('rewinds the painted turn and keeps replay visible after /clear (Deck=%s)', async (deck) => {
    const ws = tempWorkspace(),
      providers = new ProviderRegistry();
    providers.register('p', new ScriptedProvider([textScript('保留轮次输出'), textScript('删除轮次输出')]));
    const session = await createSession({
      cwd: ws.dir,
      providers,
      config: ConfigSchema.parse({
        providers: { p: { driver: 'openai-compat', auth: 'none' } },
        default: 'p:m',
        logsDir: 'logs',
        swarm: { worktrees: false },
      }),
    });
    const f = await appFixture(session, deck);
    try {
      f.controller.submit(missionInput(loadStrategies('', ''), '保留轮次'), '保留轮次');
      await f.controller.whenIdle();
      f.controller.submit(missionInput(loadStrategies('', ''), '删除轮次'), '删除轮次');
      await f.controller.whenIdle();
      f.store.flush();
      if (deck) {
        await f.send('\x1b[17~');
        await f.send('\t');
        await f.send('2');
      }
      await vi.waitFor(() => expect(f.tty.frame()).toContain('删除轮次输出'));
      f.controller.runCommand('/clear');
      await tick();
      f.controller.runCommand('/rewind 2');
      await f.controller.whenIdle();
      await vi.waitFor(() => {
        expect(f.tty.frame()).toContain('保留轮次输出');
        expect(f.tty.frame()).not.toContain('删除轮次输出');
      });
      if (deck) expect(f.tty.frame()).toContain('保留轮次');
    } finally {
      await f.close();
    }
  });
});
