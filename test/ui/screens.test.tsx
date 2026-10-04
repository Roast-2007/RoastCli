import type { ReactElement } from 'react';
import type { Instance } from 'ink';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession } from '../../src/agent/session.js';
import type { RoastConfig } from '../../src/core/config.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import { App, type AppProps } from '../../src/ui/App.js';
import { MissionControl, type MissionControlProps } from '../../src/ui/mission/MissionControl.js';
import { ProviderWizard, type ProviderWizardProps } from '../../src/ui/providers/ProviderWizard.js';
import { releaseScreen, runInteractive } from '../../src/ui/screens.js';
import { ScriptedProvider } from '../fixtures/scripted-provider.js';
import { tempWorkspace } from '../fixtures/workspace.js';

const fake = vi.hoisted(() => ({ rendered: [] as { element: ReactElement; instance: Instance; options: Record<string, unknown> }[], lifecycle: [] as string[] }));
vi.mock('ink', async (original) => ({
  ...await original<typeof import('ink')>(),
  render: (element: ReactElement, options: Record<string, unknown>) => {
    const id = fake.rendered.length;
    let exit!: () => void;
    const exited = new Promise<void>((resolve) => { exit = resolve; });
    const instance: Instance = {
      rerender: vi.fn(), cleanup: vi.fn(),
      clear: () => { fake.lifecycle.push(`clear:${id}`); },
      unmount: () => { fake.lifecycle.push(`unmount:${id}`); exit(); },
      waitUntilRenderFlush: async () => { fake.lifecycle.push(`flush:${id}`); },
      waitUntilExit: () => exited,
    };
    fake.lifecycle.push(`mount:${id}`);
    fake.rendered.push({ element, options, instance });
    return instance;
  },
}));

const config: RoastConfig = { providers: { p: { driver: 'openai-compat', apiKeyEnv: 'UNUSED' } }, default: 'p:m', maxSteps: 10, logsDir: 'logs', debugLog: false, context: {}, swarm: { maxAgents: 12, maxDepth: 3, maxMinutes: 60 } };
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
beforeEach(() => { fake.rendered = []; fake.lifecycle = []; });

describe('screen lifecycle', () => {
  it('restores the old display after a failed resume without printing its history again', async () => {
    const providers = new ProviderRegistry(); providers.register('p', new ScriptedProvider([]));
    const session = await createSession({ cwd: tempWorkspace().dir, config, providers });
    const running = runInteractive(session);
    const app = fake.rendered[0]!.element as ReactElement<AppProps>;
    app.props.store!.addNotice('main', 'already printed');
    vi.spyOn(session, 'resume').mockRejectedValue(new Error('damaged log'));
    app.props.controller!.resumeSession('bad.jsonl'); await tick();
    const returned = fake.rendered.at(-1)!.element as ReactElement<AppProps>;
    expect(returned.type).toBe(App);
    expect(returned.props.session).toBe(session);
    expect(returned.props.printedUpTo).toBe(1);
    expect(returned.props.store!.getState().agents.main!.items.at(-1)).toMatchObject({ kind: 'notice', text: expect.stringContaining('damaged log') });
    fake.rendered.at(-1)!.instance.unmount(); await running;
  });
  it('closes a loaded candidate when the user exits while restoring', async () => {
    const providers = new ProviderRegistry(); providers.register('p', new ScriptedProvider([]));
    const session = await createSession({ cwd: tempWorkspace().dir, config, providers });
    const next = await createSession({ cwd: tempWorkspace().dir, config, providers });
    const close = vi.spyOn(next, 'shutdown');
    let resolve!: (session: typeof next) => void;
    vi.spyOn(session, 'resume').mockImplementation(() => new Promise((r) => { resolve = r; }));
    const running = runInteractive(session);
    const app = fake.rendered[0]!.element as ReactElement<AppProps>;
    app.props.controller!.resumeSession('next.jsonl'); await tick();
    const loading = fake.rendered.at(-1)!.element as ReactElement<{ onExit(): void }>;
    loading.props.onExit(); resolve(next); await running;
    expect(close).toHaveBeenCalledTimes(1);
    expect(fake.rendered).toHaveLength(2);
  });
  it('clears the display without replacing the session, then restores a different saved run', async () => {
    const providers = new ProviderRegistry(); providers.register('p', new ScriptedProvider([]));
    const cwd = tempWorkspace().dir;
    const old = await createSession({ cwd, config, providers });
    const oldPath = old.log.path; await old.shutdown();
    const session = await createSession({ cwd, config, providers });
    const running = runInteractive(session);
    const app = fake.rendered[0]!.element as ReactElement<AppProps>;
    app.props.controller!.runCommand('/clear');
    await tick();
    const cleared = fake.rendered.at(-1)!.element as ReactElement<AppProps>;
    expect(cleared.props.session).toBe(session);
    expect(cleared.props.inputDraft).toBe(app.props.inputDraft);
    cleared.props.controller!.resumeSession(oldPath);
    for (let i = 0; i < 30 && (fake.rendered.at(-1)?.element.type !== App || (fake.rendered.at(-1)?.element as ReactElement<AppProps>).props.session === session); i++) await tick();
    const restored = fake.rendered.at(-1)!.element as ReactElement<AppProps>;
    expect(restored.props.session).not.toBe(session);
    expect(restored.props.session.resumedFrom?.runId).toBe(old.log.header.runId);
    expect(restored.props.store).not.toBe(app.props.store);
    fake.rendered.at(-1)!.instance.unmount(); await running;
  });
  it('serializes repeated mission switches, clears old activity, preserves new items and keeps one draft', async () => {
    const providers = new ProviderRegistry(); providers.register('p', new ScriptedProvider([]));
    const session = await createSession({ cwd: tempWorkspace().dir, config, providers });
    const running = runInteractive(session);
    const app = fake.rendered[0]!.element as ReactElement<AppProps>;
    expect(app.type).toBe(App);
    app.props.store!.addNotice('main', 'before-switch');
    app.props.onMissionControl!(); app.props.onMissionControl!();
    await tick();
    expect(fake.rendered).toHaveLength(2);
    expect(fake.lifecycle.slice(0, 5)).toEqual(['mount:0', 'flush:0', 'clear:0', 'unmount:0', 'mount:1']);
    const mission = fake.rendered[1]!.element as ReactElement<MissionControlProps>;
    expect(mission.type).toBe(MissionControl);
    app.props.store!.addNotice('main', 'while-in-mission');
    mission.props.onExit(); mission.props.onExit();
    await tick();
    expect(fake.rendered).toHaveLength(3);
    const returned = fake.rendered[2]!.element as ReactElement<AppProps>;
    expect(returned.props.printedUpTo).toBe(1);
    expect(returned.props.store!.getState().agents['main']!.items).toHaveLength(2);
    expect(returned.props.inputDraft).toBe(app.props.inputDraft);
    expect(fake.lifecycle).not.toContain('clear:1');
    for (let i = 0; i < 3; i++) {
      const inline = fake.rendered.at(-1)!.element as ReactElement<AppProps>;
      inline.props.onMissionControl!(); await tick();
      (fake.rendered.at(-1)!.element as ReactElement<MissionControlProps>).props.onExit(); await tick();
    }
    fake.rendered.at(-1)!.instance.unmount();
    await running;
  });

  it('/provider uses the same handoff and returns without replacing the current session', async () => {
    const providers = new ProviderRegistry(); providers.register('p', new ScriptedProvider([]));
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
    expect(returned.props.store!.getState().agents['main']!.items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'notice', text: '供应商配置已保存，下一次启动生效' })]));
    fake.rendered[2]!.instance.unmount(); await running;
  });

  it('waits for outgoing terminal writes before letting the next screen mount', async () => {
    let finish!: () => void;
    const drained = new Promise<void>((resolve) => { finish = resolve; });
    const instance = { waitUntilRenderFlush: async () => {}, clear: vi.fn(), unmount: vi.fn(), waitUntilExit: () => drained } as unknown as Instance;
    let released = false;
    const task = releaseScreen(instance, true).then(() => { released = true; });
    await tick();
    expect(instance.clear).toHaveBeenCalled();
    expect(instance.unmount).toHaveBeenCalled();
    expect(released).toBe(false);
    finish(); await task;
    expect(released).toBe(true);
  });
});
