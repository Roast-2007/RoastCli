/**
 * 交互模式的屏幕管理：inline 对话 ⇄ 全屏 Mission Control。
 * store 与控制器在组件树之外创建，切换时卸载/重挂 Ink 实例不影响进行中的 turn：
 * - 进入全屏：等最后一帧刷出 → 卸载 inline → 以 alternateScreen 渲染 Mission Control
 * - 返回：卸载全屏（终端恢复主屏幕）→ 重挂 inline，Static 只输出水位线之后的新条目（不重复打印历史）
 */
import { createElement } from 'react';
import { Text, render, useInput, type Instance } from 'ink';
import type { Session } from '../agent/session.js';
import { App } from './App.js';
import { MissionControl } from './mission/MissionControl.js';
import { createUiController } from './controller.js';
import { createUiStore } from './store/store.js';
import { savedWorktreesText } from '../cli/worktrees.js';
import { ProviderWizard } from './providers/ProviderWizard.js';
import { TrustPanel } from './components/TrustPanel.js';
import type { EditorState } from './input/editor.js';

/** Clear while Ink still knows the activity height/caret, before losing its renderer state. */
export async function releaseScreen(instance: Instance, inline: boolean, onFlushed?: () => void): Promise<void> {
  await instance.waitUntilRenderFlush();
  onFlushed?.();
  if (inline) instance.clear();
  instance.unmount();
  await instance.waitUntilExit().catch(() => {});
}

export async function runProviderWizard(cwd: string): Promise<boolean> {
  let saved = false;
  const instance = render(createElement(ProviderWizard, { cwd, onExit: (result: boolean) => { saved = result; instance.unmount(); } }), {
    exitOnCtrlC: false,
    alternateScreen: true,
    kittyKeyboard: { mode: 'auto' },
  });
  await instance.waitUntilExit();
  return saved;
}

export async function runTrustPrompt(cwd: string): Promise<boolean> {
  let trusted = false;
  const instance = render(createElement(TrustPanel, { cwd, onExit: (result: boolean) => { trusted = result; instance.unmount(); } }), {
    exitOnCtrlC: false,
    alternateScreen: true,
    kittyKeyboard: { mode: 'auto' },
  });
  await instance.waitUntilExit();
  return trusted;
}

export async function runInteractive(session: Session, opts: { initialPrompt?: string } = {}): Promise<void> {
  let store = createUiStore();
  let instance: Instance | null = null;
  const activeInstance = () => instance;
  let switching = false;
  let switchTask: Promise<void> = Promise.resolve();
  let quitRequested = false;
  let resolveQuit!: () => void;
  const quit = new Promise<void>((r) => (resolveQuit = r));
  const requestExit = () => { quitRequested = true; instance?.unmount(); resolveQuit(); };
  const makeController = () => createUiController(session, store, { exit: requestExit, openProviders: () => requestSwitch('providers'), clearScreen: () => requestSwitch('inline', true), openSession: (path) => { if (!switching) switchTask = restoreSession(path); } });
  let controller = makeController();
  const inputDraft: { seed?: number; state?: EditorState } = {};
  let currentScreen: 'inline' | 'mission' | 'providers' = 'inline';
  let printedUpTo: number | undefined;
  let initialPrompt = opts.initialPrompt;

  const watch = (inst: Instance) => {
    void inst.waitUntilExit().then(
      () => (switching || instance !== inst ? undefined : resolveQuit()),
      () => (switching || instance !== inst ? undefined : resolveQuit()),
    );
  };

  const mountInline = () => {
    instance = render(
      createElement(App, {
        session,
        store,
        controller,
        inputDraft,
        ...(initialPrompt ? { initialPrompt } : {}),
        ...(printedUpTo !== undefined ? { printedUpTo } : {}),
        onMissionControl: () => requestSwitch('mission'),
      }),
      { exitOnCtrlC: false, maxFps: 30, incrementalRendering: true, kittyKeyboard: { mode: 'auto' } },
    );
    initialPrompt = undefined;
    watch(instance);
  };

  const mountMission = () => {
    instance = render(createElement(MissionControl, { session, store, controller, onExit: () => requestSwitch('inline') }), {
      exitOnCtrlC: false,
      alternateScreen: true,
      incrementalRendering: true,
      maxFps: 30,
      kittyKeyboard: { mode: 'auto' },
    });
    watch(instance);
  };

  const mountProviders = () => {
    instance = render(createElement(ProviderWizard, { cwd: session.log.header.cwd, ui: { ...session.config.ui, ...(store.getState().meta.theme ? { theme: store.getState().meta.theme } : {}) }, onExit: (saved: boolean) => {
      if (saved) store.addNotice('main', '供应商配置已保存，下一次启动生效', 'success');
      requestSwitch('inline');
    } }), { exitOnCtrlC: false, alternateScreen: true, kittyKeyboard: { mode: 'auto' } });
    watch(instance);
  };

  function requestSwitch(screen: typeof currentScreen, clear = false): void {
    if (!switching) switchTask = switchTo(screen, clear);
  }

  async function switchTo(screen: typeof currentScreen, clear = false): Promise<void> {
    if (!instance || switching || (screen === currentScreen && !clear)) return;
    switching = true;
    try {
      store.flush();
      await releaseScreen(instance, currentScreen === 'inline', () => {
        if (currentScreen === 'inline') {
          const items = store.getState().agents['main']?.items ?? [];
          printedUpTo = items.length ? items[items.length - 1]!.id : 0;
        }
      });
      instance = null;
      if (quitRequested) return;
      if (clear) process.stdout.write('\u001b[2J\u001b[H');
      store.flush();
      currentScreen = screen;
      controller.setScreen(screen);
      if (screen === 'mission') mountMission();
      else if (screen === 'providers') mountProviders();
      else mountInline();
    } catch (err) {
      // Report the error after restoring the primary screen, without leaving an orphan renderer.
      instance?.unmount();
      await instance?.waitUntilExit().catch(() => {});
      instance = null;
      store.addNotice('main', `界面切换失败：${err instanceof Error ? err.message : String(err)}`, 'error');
      currentScreen = 'inline';
      controller.setScreen('inline');
      if (!quitRequested) mountInline();
    } finally {
      switching = false;
    }
  }

  async function restoreSession(logPath: string): Promise<void> {
    if (!instance || switching) return;
    switching = true;
    let candidate: Session | undefined;
    try {
      store.flush();
      await releaseScreen(instance, currentScreen === 'inline', () => {
        if (currentScreen === 'inline') printedUpTo = store.getState().agents['main']!.items.at(-1)?.id ?? 0;
      });
      instance = render(createElement(SessionLoading, { onExit: requestExit }), { exitOnCtrlC: false, maxFps: 30 });
      const next = await session.resume(logPath);
      candidate = next;
      if (quitRequested) { await next.shutdown(); return; }
      await releaseScreen(instance, true);
      controller.dispose();
      const retained = await session.shutdown().catch(() => ({ worktrees: [] as string[] }));
      process.stderr.write(savedWorktreesText(retained.worktrees));
      session = next;
      store = createUiStore();
      controller = makeController();
      delete inputDraft.seed; delete inputDraft.state;
      printedUpTo = undefined;
      initialPrompt = undefined;
      currentScreen = 'inline';
      mountInline();
    } catch (err) {
      if (candidate && candidate !== session) await candidate.shutdown().catch(() => {});
      instance?.unmount(); await instance?.waitUntilExit().catch(() => {});
      instance = null;
      store.addNotice('main', `恢复会话失败：${err instanceof Error ? err.message : String(err)}`, 'error');
      if (!quitRequested) {
        currentScreen = 'inline'; controller.setScreen('inline'); mountInline();
      }
    } finally { switching = false; }
  }

  try {
    mountInline();
    await quit;
  } finally {
    quitRequested = true;
    await switchTask;
    activeInstance()?.unmount();
    instance = null;
    controller.interrupt();
    await controller.whenIdle();
    controller.dispose();
    process.stderr.write(savedWorktreesText((await session.shutdown()).worktrees));
  }
}

function SessionLoading({ onExit }: { onExit(): void }) {
  useInput((input, key) => { if (key.escape || (key.ctrl && input === 'c')) onExit(); });
  return createElement(Text, { dimColor: true }, '正在恢复会话… · Esc / Ctrl+C 退出');
}
