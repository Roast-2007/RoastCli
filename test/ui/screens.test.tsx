import type { ReactElement } from 'react';
import type { Instance } from 'ink';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession } from '../../src/agent/session.js';
import type { RoastConfig } from '../../src/core/config.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import { App, type AppProps } from '../../src/ui/App.js';
import { Deck as MissionControl, type DeckProps as MissionControlProps } from '../../src/ui/hive/Deck.js';
import { ProviderWizard, type ProviderWizardProps } from '../../src/ui/providers/ProviderWizard.js';
import { releaseScreen, runInteractive } from '../../src/ui/screens.js';
import { ScriptedProvider } from '../fixtures/scripted-provider.js';
import { tempWorkspace } from '../fixtures/workspace.js';
import { checkForUpdate } from '../../src/cli/update.js';
import { createEditor, editorReducer } from '../../src/ui/input/editor.js';
import { textScript } from '../fixtures/chunks.js';
import { loadRunLog } from '../../src/session/projection.js';

vi.mock('../../src/cli/update.js', async (original) => ({
  ...(await original<typeof import('../../src/cli/update.js')>()),
  checkForUpdate: vi.fn(async () => undefined),
}));

const fake = vi.hoisted(() => ({
  rendered: [] as { element: ReactElement; instance: Instance; options: Record<string, unknown> }[],
  lifecycle: [] as string[],
}));
vi.mock('ink', async (original) => ({
  ...(await original<typeof import('ink')>()),
  render: (element: ReactElement, options: Record<string, unknown>) => {
    const id = fake.rendered.length;
    let exit!: () => void;
    const exited = new Promise<void>((resolve) => {
      exit = resolve;
    });
    const instance: Instance = {
      rerender: (element) => {
        fake.lifecycle.push(`rerender:${id}`);
        fake.rendered.push({ element: element as ReactElement, options, instance });
      },
      cleanup: vi.fn(),
      clear: () => {
        fake.lifecycle.push(`clear:${id}`);
      },
      unmount: () => {
        fake.lifecycle.push(`unmount:${id}`);
        exit();
      },
      waitUntilRenderFlush: async () => {
        fake.lifecycle.push(`flush:${id}`);
      },
      waitUntilExit: () => exited,
    };
    fake.lifecycle.push(`mount:${id}`);
    fake.rendered.push({ element, options, instance });
    return instance;
  },
}));

const config: RoastConfig = {
  providers: { p: { driver: 'openai-compat', apiKeyEnv: 'UNUSED' } },
  default: 'p:m',
  maxSteps: 10,
  logsDir: 'logs',
  debugLog: false,
  context: {},
  ui: { home: 'chat' },
  swarm: { maxAgents: 12, maxDepth: 3, maxMinutes: 60 },
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
beforeEach(() => {
  fake.rendered = [];
  fake.lifecycle = [];
  vi.mocked(checkForUpdate).mockReset().mockResolvedValue(undefined);
});

describe('screen lifecycle', () => {
  it('defaults to Hive, preserves both drafts and leaves provider prefixes stable across switches', async () => {
    const providers = new ProviderRegistry();
    providers.register('p', new ScriptedProvider([textScript('first'), textScript('second')]));
    const session = await createSession({ cwd: tempWorkspace().dir, config: { ...config, ui: {} }, providers });
    const running = runInteractive(session);
    const hive = fake.rendered[0]!.element as ReactElement<MissionControlProps>;
    expect(hive.type).toBe(MissionControl);
    hive.props.inputDraft!.state = editorReducer(createEditor(), { type: 'set', text: '蜂群草稿' });
    hive.props.controller.submit('目标', '目标');
    await hive.props.controller.whenIdle();
    hive.props.onExit();
    const chat = fake.rendered.at(-1)!.element as ReactElement<AppProps>;
    chat.props.inputDraft!.state = editorReducer(createEditor(), { type: 'set', text: '对话草稿' });
    chat.props.controller!.submit('follow up', 'follow up');
    await chat.props.controller!.whenIdle();
    chat.props.onMissionControl!();
    const again = fake.rendered.at(-1)!.element as ReactElement<MissionControlProps>;
    expect(again.props.inputDraft!.state!.lines).toEqual(['蜂群草稿']);
    again.props.onExit();
    expect((fake.rendered.at(-1)!.element as ReactElement<AppProps>).props.inputDraft!.state!.lines).toEqual(['对话草稿']);
    const events = loadRunLog(session.log.path).events;
    const starts = events.filter((event) => event.type === 'request/digest');
    expect(starts).toHaveLength(2);
    expect(starts[0]).toMatchObject({ systemHash: starts[1]!.systemHash, toolsHash: starts[1]!.toolsHash });
    fake.rendered.at(-1)!.instance.unmount();
    await running;
  });
  it('honors launch overrides over the configured home', async () => {
    for (const home of ['chat', 'hive'] as const) {
      const providers = new ProviderRegistry();
      providers.register('p', new ScriptedProvider([]));
      const session = await createSession({
        cwd: tempWorkspace().dir,
        config: { ...config, ui: { home: home === 'chat' ? 'hive' : 'chat' } },
        providers,
      });
      const running = runInteractive(session, { home });
      expect(fake.rendered.at(-1)!.element.type).toBe(home === 'hive' ? MissionControl : App);
      fake.rendered.at(-1)!.instance.unmount();
      await running;
    }
  });
  it('checks each launch in the background and delivers a notice without changing the draft or model history', async () => {
    let finish!: (release: { version: string }) => void;
    vi.mocked(checkForUpdate).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const providers = new ProviderRegistry();
    providers.register('p', new ScriptedProvider([]));
    const session = await createSession({ cwd: tempWorkspace().dir, config, providers });
    const running = runInteractive(session);
    const app = fake.rendered[0]!.element as ReactElement<AppProps>;
    const initialEvents = [...session.initialEvents];
    expect(app.type).toBe(App);
    app.props.onMissionControl!();
    finish({ version: '0.4.2' });
    await tick();
    expect(app.props.store!.getState().meta.signals).toContainEqual({ tone: 'info', text: expect.stringContaining('roast update') });
    expect(app.props.store!.getState().agents.main!.items).toEqual([]);
    (fake.rendered.at(-1)!.element as ReactElement<MissionControlProps>).props.onExit();
    const returned = fake.rendered.at(-1)!.element as ReactElement<AppProps>;
    expect(returned.props.inputDraft).toBe(app.props.inputDraft);
    expect(session.initialEvents).toEqual(initialEvents);
    fake.rendered.at(-1)!.instance.unmount();
    await running;
    expect(vi.mocked(checkForUpdate).mock.calls[0]![0]!.signal!.aborted).toBe(true);
    const next = await createSession({ cwd: tempWorkspace().dir, config, providers });
    const reopened = runInteractive(next);
    fake.rendered.at(-1)!.instance.unmount();
    await reopened;
    expect(checkForUpdate).toHaveBeenCalledTimes(2);
  });

  it('ignores a late update response after the terminal closes', async () => {
    let finish!: (release: { version: string }) => void;
    vi.mocked(checkForUpdate).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const providers = new ProviderRegistry();
    providers.register('p', new ScriptedProvider([]));
    const session = await createSession({ cwd: tempWorkspace().dir, config, providers });
    const running = runInteractive(session);
    const app = fake.rendered[0]!.element as ReactElement<AppProps>;
    fake.rendered[0]!.instance.unmount();
    await running;
    finish({ version: '0.4.2' });
    await tick();
    expect(app.props.store!.getState().agents.main!.items).toHaveLength(0);
  });

  it('restores the whole fullscreen history after a failed resume', async () => {
    const providers = new ProviderRegistry();
    providers.register('p', new ScriptedProvider([]));
    const session = await createSession({ cwd: tempWorkspace().dir, config, providers });
    const running = runInteractive(session);
    const app = fake.rendered[0]!.element as ReactElement<AppProps>;
    app.props.store!.addNotice('main', 'already printed');
    vi.spyOn(session, 'resume').mockRejectedValue(new Error('damaged log'));
    app.props.controller!.resumeSession('bad.jsonl');
    await tick();
    const returned = fake.rendered.at(-1)!.element as ReactElement<AppProps>;
    expect(returned.type).toBe(App);
    expect(returned.props.session).toBe(session);
    expect(returned.props.printedUpTo).toBeUndefined();
    expect(fake.rendered.every((r) => r.instance === fake.rendered[0]!.instance)).toBe(true);
    expect(returned.props.store!.getState().agents.main!.items.at(-1)).toMatchObject({
      kind: 'notice',
      text: expect.stringContaining('damaged log'),
    });
    fake.rendered.at(-1)!.instance.unmount();
    await running;
  });
  it('closes a loaded candidate when the user exits while restoring', async () => {
    const providers = new ProviderRegistry();
    providers.register('p', new ScriptedProvider([]));
    const session = await createSession({ cwd: tempWorkspace().dir, config, providers });
    const next = await createSession({ cwd: tempWorkspace().dir, config, providers });
    const close = vi.spyOn(next, 'shutdown');
    let resolve!: (session: typeof next) => void;
    vi.spyOn(session, 'resume').mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const running = runInteractive(session);
    const app = fake.rendered[0]!.element as ReactElement<AppProps>;
    app.props.controller!.resumeSession('next.jsonl');
    await tick();
    const loading = fake.rendered.at(-1)!.element as ReactElement<{ onExit(): void }>;
    loading.props.onExit();
    resolve(next);
    await running;
    expect(close).toHaveBeenCalledTimes(1);
    expect(fake.rendered).toHaveLength(2);
  });
  it('clears the display without replacing the session, then restores a different saved run', async () => {
    const providers = new ProviderRegistry();
    providers.register('p', new ScriptedProvider([]));
    const cwd = tempWorkspace().dir;
    const old = await createSession({ cwd, config, providers });
    const oldPath = old.log.path;
    await old.shutdown();
    const session = await createSession({ cwd, config, providers });
    const running = runInteractive(session);
    const app = fake.rendered[0]!.element as ReactElement<AppProps>;
    app.props.controller!.runCommand('/clear');
    await tick();
    const cleared = fake.rendered.at(-1)!.element as ReactElement<AppProps>;
    expect(cleared.props.session).toBe(session);
    expect(cleared.props.inputDraft).toBe(app.props.inputDraft);
    cleared.props.controller!.resumeSession(oldPath);
    for (
      let i = 0;
      i < 30 &&
      (fake.rendered.at(-1)?.element.type !== App || (fake.rendered.at(-1)?.element as ReactElement<AppProps>).props.session === session);
      i++
    )
      await tick();
    const restored = fake.rendered.at(-1)!.element as ReactElement<AppProps>;
    expect(restored.props.session).not.toBe(session);
    expect(restored.props.session.resumedFrom?.runId).toBe(old.log.header.runId);
    expect(restored.props.store).not.toBe(app.props.store);
    fake.rendered.at(-1)!.instance.unmount();
    await running;
  });
  it('reuses one alternate buffer across mission switches and preserves history and draft', async () => {
    const providers = new ProviderRegistry();
    providers.register('p', new ScriptedProvider([]));
    const session = await createSession({ cwd: tempWorkspace().dir, config, providers });
    const running = runInteractive(session);
    const app = fake.rendered[0]!.element as ReactElement<AppProps>;
    expect(app.type).toBe(App);
    expect(app.props.fullScreen).toBe(true);
    expect(app.props.startup).toBe(true);
    expect(fake.rendered[0]!.options['alternateScreen']).toBe(true);
    app.props.store!.addNotice('main', 'before-switch');
    app.props.onMissionControl!();
    app.props.onMissionControl!();
    await tick();
    expect(fake.rendered).toHaveLength(2);
    expect(fake.lifecycle).toEqual(['mount:0', 'rerender:0']);
    const mission = fake.rendered[1]!.element as ReactElement<MissionControlProps>;
    expect(mission.type).toBe(MissionControl);
    app.props.store!.addNotice('main', 'while-in-mission');
    mission.props.onExit();
    mission.props.onExit();
    await tick();
    expect(fake.rendered).toHaveLength(3);
    const returned = fake.rendered[2]!.element as ReactElement<AppProps>;
    expect(returned.props.printedUpTo).toBeUndefined();
    expect(returned.props.startup).toBe(false);
    expect(returned.props.store!.getState().agents['main']!.items).toHaveLength(2);
    expect(returned.props.inputDraft).toBe(app.props.inputDraft);
    expect(fake.rendered.every((r) => r.instance === fake.rendered[0]!.instance)).toBe(true);
    expect(fake.lifecycle.some((entry) => entry.startsWith('clear:') || entry.startsWith('unmount:'))).toBe(false);
    for (let i = 0; i < 3; i++) {
      const inline = fake.rendered.at(-1)!.element as ReactElement<AppProps>;
      inline.props.onMissionControl!();
      await tick();
      (fake.rendered.at(-1)!.element as ReactElement<MissionControlProps>).props.onExit();
      await tick();
    }
    fake.rendered.at(-1)!.instance.unmount();
    await running;
  });

  it('/provider uses the same handoff and returns without replacing the current session', async () => {
    const providers = new ProviderRegistry();
    providers.register('p', new ScriptedProvider([]));
    const session = await createSession({ cwd: tempWorkspace().dir, config, providers });
    const running = runInteractive(session);
    const app = fake.rendered[0]!.element as ReactElement<AppProps>;
    app.props.controller!.runCommand('/provider');
    await tick();
    const wizard = fake.rendered[1]!.element as ReactElement<ProviderWizardProps>;
    expect(wizard.type).toBe(ProviderWizard);
    expect(fake.rendered[1]!.options['alternateScreen']).toBe(true);
    wizard.props.onExit(true);
    await tick();
    const returned = fake.rendered[2]!.element as ReactElement<AppProps>;
    expect(returned.props.session).toBe(session);
    expect(returned.props.store!.getState().agents['main']!.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'notice', text: '供应商配置已保存，下一次启动生效' })]),
    );
    fake.rendered[2]!.instance.unmount();
    await running;
  });

  it('waits for outgoing terminal writes before letting the next screen mount', async () => {
    let finish!: () => void;
    const drained = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const instance = {
      waitUntilRenderFlush: async () => {},
      clear: vi.fn(),
      unmount: vi.fn(),
      waitUntilExit: () => drained,
    } as unknown as Instance;
    let released = false;
    const task = releaseScreen(instance, true).then(() => {
      released = true;
    });
    await tick();
    expect(instance.clear).toHaveBeenCalled();
    expect(instance.unmount).toHaveBeenCalled();
    expect(released).toBe(false);
    finish();
    await task;
    expect(released).toBe(true);
  });
});
