/**
 * One alternate-screen renderer for the whole interactive workspace.
 * Screen changes replace its React tree without leaving/re-entering the terminal buffer.
 * The controller, conversation history and editor draft survive every handoff.
 */
import { createElement, type ReactNode } from 'react';
import { Box, Text, render, useInput, useWindowSize, type Instance } from 'ink';
import type { Session } from '../agent/session.js';
import { App } from './App.js';
import { Deck } from './hive/Deck.js';
import { createUiController } from './controller.js';
import { createUiStore } from './store/store.js';
import { savedWorktreesText } from '../cli/worktrees.js';
import { ProviderWizard } from './providers/ProviderWizard.js';
import { TrustPanel } from './components/TrustPanel.js';
import type { EditorState } from './input/editor.js';
import { checkForUpdate, updateNotice, type LatestRelease } from '../cli/update.js';

/** Clear while Ink still knows the activity height/caret, before losing its renderer state. */
export async function releaseScreen(instance: Instance, inline: boolean, onFlushed?: () => void): Promise<void> {
  const exited = instance.waitUntilExit();
  await instance.waitUntilRenderFlush();
  onFlushed?.();
  if (inline) instance.clear();
  instance.unmount();
  await exited.catch(() => {});
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

export async function runInteractive(session: Session, opts: { initialPrompt?: import('../agent/runtime.js').RuntimeInput; home?: 'hive' | 'chat' } = {}): Promise<void> {
  let store = createUiStore();
  let instance: Instance | null = null;
  const activeInstance = () => instance;
  let instanceExit: Promise<unknown> = Promise.resolve();
  let switching = false;
  let switchTask: Promise<void> = Promise.resolve();
  let quitRequested = false;
  let resolveQuit!: () => void;
  const quit = new Promise<void>((r) => (resolveQuit = r));
  const requestExit = () => { quitRequested = true; instance?.unmount(); resolveQuit(); };
  const makeController = () => createUiController(session, store, { exit: requestExit, openProviders: () => requestSwitch('providers'), openWorkspace: (screen) => requestSwitch(screen), clearScreen: () => requestSwitch(currentScreen === 'hive' ? 'hive' : 'inline', true), openSession: (path) => { if (!switching) switchTask = restoreSession(path); } });
  let controller = makeController();
  const inputDraft: { seed?: number; state?: EditorState } = {};
  const hiveDraft: { seed?: number; state?: EditorState } = {};
  const home = opts.home ?? session.config.ui?.home ?? 'hive';
  let currentScreen: 'inline' | 'hive' | 'providers' = home === 'hive' ? 'hive' : 'inline';
  let previousWorkspace: 'inline' | 'hive' = currentScreen;
  let printedUpTo: number | undefined;
  let initialPrompt = opts.initialPrompt;
  let firstMount = true;
  const updateAbort = new AbortController();
  let availableUpdate: LatestRelease | undefined;

  const watch = (inst: Instance) => {
    instanceExit = inst.waitUntilExit();
    void instanceExit.then(
      () => (instance !== inst ? undefined : resolveQuit()),
      () => (instance !== inst ? undefined : resolveQuit()),
    );
  };

  const show = (element: ReactNode) => {
    if (instance) instance.rerender(element);
    else {
      instance = render(element, { exitOnCtrlC: false, alternateScreen: true, maxFps: 30, incrementalRendering: true, kittyKeyboard: { mode: 'auto' } });
      watch(instance);
    }
  };

  const mountInline = () => {
    show(createElement(App, {
        key: printedUpTo ?? 0,
        session,
        store,
        controller,
        inputDraft,
        fullScreen: true,
        startup: firstMount,
        ...(initialPrompt ? { initialPrompt } : {}),
        ...(printedUpTo !== undefined ? { printedUpTo } : {}),
        onMissionControl: () => requestSwitch('hive'),
      }));
    firstMount = false;
    initialPrompt = undefined;
  };

  const mountMission = () => {
    show(createElement(Deck, { session, store, controller, inputDraft: hiveDraft, startup: firstMount, ...(initialPrompt ? { initialPrompt } : {}), onExit: () => requestSwitch('inline') }));
    firstMount = false;
    initialPrompt = undefined;
  };

  const mountProviders = () => {
    show(createElement(ProviderWizard, { cwd: session.log.header.cwd, ui: { ...session.config.ui, ...(store.getState().meta.theme ? { theme: store.getState().meta.theme } : {}) }, onExit: (saved: boolean) => {
      if (saved) store.addNotice('main', '供应商配置已保存，下一次启动生效', 'success');
      requestSwitch(previousWorkspace);
    } }));
  };

  function requestSwitch(screen: typeof currentScreen, clear = false): void {
    if (!switching && !quitRequested) switchTo(screen, clear);
  }

  function switchTo(screen: typeof currentScreen, clear = false): void {
    if (!instance || switching || (screen === currentScreen && !clear)) return;
    switching = true;
    try {
      store.flush();
      if (clear) printedUpTo = store.getState().agents.main!.items.at(-1)?.id ?? 0;
      currentScreen = screen;
      if (screen !== 'providers') previousWorkspace = screen;
      controller.setScreen(screen);
      if (screen === 'hive') mountMission();
      else if (screen === 'providers') mountProviders();
      else mountInline();
    } catch (err) {
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
    const returnScreen = currentScreen;
    try {
      store.flush();
      show(createElement(SessionLoading, { onExit: requestExit }));
      const next = await session.resume(logPath);
      candidate = next;
      if (quitRequested) { await next.shutdown(); return; }
      controller.dispose();
      const retained = await session.shutdown().catch(() => ({ worktrees: [] as string[] }));
      process.stderr.write(savedWorktreesText(retained.worktrees));
      session = next;
      store = createUiStore();
      controller = makeController();
      if (availableUpdate) store.addNotice('main', updateNotice(availableUpdate), 'info');
      delete inputDraft.seed; delete inputDraft.state;
      delete hiveDraft.seed; delete hiveDraft.state;
      printedUpTo = undefined;
      initialPrompt = undefined;
      currentScreen = home === 'hive' ? 'hive' : 'inline';
      controller.setScreen(currentScreen);
      if (currentScreen === 'hive') mountMission(); else mountInline();
    } catch (err) {
      if (candidate && candidate !== session) await candidate.shutdown().catch(() => {});
      store.addNotice('main', `恢复会话失败：${err instanceof Error ? err.message : String(err)}`, 'error');
      if (!quitRequested) {
        currentScreen = returnScreen; controller.setScreen(currentScreen); if (currentScreen === 'hive') mountMission(); else mountInline();
      }
    } finally { switching = false; }
  }

  try {
    controller.setScreen(currentScreen);
    if (currentScreen === 'hive') mountMission(); else mountInline();
    void checkForUpdate({ signal: updateAbort.signal }).then((release) => {
      if (quitRequested || updateAbort.signal.aborted || !release) return;
      availableUpdate = release;
      store.addNotice('main', updateNotice(release), 'info');
    });
    await quit;
  } finally {
    quitRequested = true;
    updateAbort.abort();
    await switchTask;
    const active = activeInstance();
    active?.unmount();
    await instanceExit.catch(() => {});
    instance = null;
    controller.interrupt();
    await controller.whenIdle();
    controller.dispose();
    process.stderr.write(savedWorktreesText((await session.shutdown()).worktrees));
  }
}

function SessionLoading({ onExit }: { onExit(): void }) {
  const { rows, columns } = useWindowSize();
  useInput((input, key) => { if (key.escape || (key.ctrl && input === 'c')) onExit(); });
  return createElement(Box, { height: Math.max(1, rows - 1), width: columns, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }, createElement(Text, { dimColor: true, wrap: 'truncate-end' }, '正在恢复会话… · Esc / Ctrl+C 退出'));
}
