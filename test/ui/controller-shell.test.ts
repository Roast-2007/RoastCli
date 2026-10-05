import { describe, expect, it, vi } from 'vitest';
import { createSession } from '../../src/agent/session.js';
import { createUiController } from '../../src/ui/controller.js';
import { createUiStore } from '../../src/ui/store/store.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import { ScriptedProvider } from '../fixtures/scripted-provider.js';
import { tempWorkspace } from '../fixtures/workspace.js';

const shellState = vi.hoisted(() => ({ timeoutMs: 0 }));
vi.mock('../../src/tools/bash/run.js', () => ({ runForeground: async (opts: { command: string; timeoutMs: number; signal: AbortSignal; onOutput?(text: string, stream: string): void }) => {
  shellState.timeoutMs = opts.timeoutMs;
  if (opts.command === 'emit-lots') return { kind: 'timeout', output: 'x'.repeat(10_000) };
  opts.onOutput?.('live shell output', 'stdout');
  await new Promise<void>((resolve) => { if (opts.signal.aborted) resolve(); else opts.signal.addEventListener('abort', () => resolve(), { once: true }); });
  return { kind: 'aborted', output: 'live shell output' };
} }));
describe('direct shell lifecycle', () => {
  it('uses the configured timeout, reports expiry and keeps large output in tool details', async () => {
    const providers = new ProviderRegistry(); providers.register('p', new ScriptedProvider([]));
    const session = await createSession({ cwd: tempWorkspace().dir, providers, config: { providers: { p: { driver: 'openai-compat', auth: 'none' } }, default: 'p:m', maxSteps: 10, logsDir: 'logs', debugLog: false, context: {}, ui: { shellTimeoutMs: 5000 }, swarm: { maxAgents: 12, maxDepth: 3, maxMinutes: 60 } } });
    const store = createUiStore(), controller = createUiController(session, store, { exit() {} });
    try {
      controller.submit('!emit-lots', '!emit-lots'); await controller.whenIdle(); store.flush();
      expect(shellState.timeoutMs).toBe(5000);
      const items = store.getState().agents.main!.items;
      const tool = items.find((i) => i.kind === 'tool');
      expect(tool?.kind === 'tool' && tool.tool.output?.length).toBe(10_000);
      expect(items.some((i) => i.kind === 'notice' && i.text.includes('超时') && i.text.length < 120)).toBe(true);
    } finally { controller.dispose(); await session.shutdown(); }
  });
  it('replaces mode toasts and stops their timer on dispose', async () => {
    const providers = new ProviderRegistry(); providers.register('p', new ScriptedProvider([]));
    const session = await createSession({ cwd: tempWorkspace().dir, providers, config: { providers: { p: { driver: 'openai-compat', apiKeyEnv: 'UNUSED' } }, default: 'p:m', maxSteps: 10, logsDir: 'logs', debugLog: false, context: {}, swarm: { maxAgents: 12, maxDepth: 3, maxMinutes: 60 } } });
    const store = createUiStore(); const controller = createUiController(session, store, { exit() {} });
    vi.useFakeTimers();
    try {
      controller.cycleMode(); expect(store.getState().meta.toast?.text).toContain('acceptEdits');
      await vi.advanceTimersByTimeAsync(2000); controller.cycleMode();
      await vi.advanceTimersByTimeAsync(1000); expect(store.getState().meta.toast?.text).toContain('plan');
      await vi.advanceTimersByTimeAsync(2000); expect(store.getState().meta.toast).toBeNull();
      controller.cycleMode(); controller.dispose(); await vi.advanceTimersByTimeAsync(100); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); controller.dispose(); await session.shutdown(); }
  });
  it('streams, interrupts, restores input submitted during the command, and settles before shutdown', async () => {
    const providers = new ProviderRegistry(); providers.register('p', new ScriptedProvider([]));
    const session = await createSession({ cwd: tempWorkspace().dir, providers, config: { providers: { p: { driver: 'openai-compat', apiKeyEnv: 'UNUSED' } }, default: 'p:m', maxSteps: 10, logsDir: 'logs', debugLog: false, context: {}, swarm: { maxAgents: 12, maxDepth: 3, maxMinutes: 60 } } });
    const store = createUiStore(); const controller = createUiController(session, store, { exit() {} });
    try {
      controller.submit('!long-command', '!long-command');
      store.flush();
      expect(controller.isRunning()).toBe(true);
      expect(store.getState().agents['main']?.tools[0]?.live).toContain('live shell');
      controller.submit('next question', 'next question');
      expect(store.getState().meta.inputSeed.text).toBe('next question');
      controller.interrupt(); await controller.whenIdle(); store.flush();
      expect(controller.isRunning()).toBe(false);
      expect(store.getState().agents['main']?.tools).toEqual([]);
      expect(store.getState().agents['main']?.items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'tool', tool: expect.objectContaining({ status: 'interrupted' }) })]));
      expect(session.loop.committer.messages()).toEqual([]);
    } finally { controller.dispose(); await session.shutdown(); }
  });
});
