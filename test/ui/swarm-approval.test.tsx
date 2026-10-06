import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { createSession } from '../../src/agent/session.js';
import type { RoastConfig } from '../../src/core/config.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import { createUiController } from '../../src/ui/controller.js';
import { createUiStore } from '../../src/ui/store/store.js';
import { App } from '../../src/ui/App.js';
import { Deck as MissionControl } from '../../src/ui/hive/Deck.js';
import { RoutedProvider } from '../fixtures/routed-provider.js';
import { textScript, toolCallScript, toolCallsScript } from '../fixtures/chunks.js';
import { tempWorkspace } from '../fixtures/workspace.js';
import type { Script } from '../fixtures/scripted-provider.js';

const config: RoastConfig = { providers: { p: { driver: 'openai-compat' } }, default: 'p:m', maxSteps: 25, logsDir: '.roast/logs', debugLog: false, context: {}, swarm: { maxAgents: 12, maxDepth: 3, maxMinutes: 60, worktrees: false } };

async function setup(children: Record<string, Script[]>) {
  const workspace = tempWorkspace();
  workspace.file('src/a.ts', 'read-only fixture');
  const provider = new RoutedProvider({ main: [
    toolCallsScript(Object.keys(children).map((_, i) => ({ id: `spawn${i}`, name: 'spawn_agent', args: { role: 'scout', task: '只读调研' } }))),
    toolCallScript('await', 'await_agents', { mode: 'all' }), textScript('research complete'),
  ], ...children });
  const providers = new ProviderRegistry(); providers.register('p', provider);
  const session = await createSession({ cwd: workspace.dir, config, providers, permissionMode: 'yolo' });
  session.swarm.setWatchdog({ steps: 2 });
  const store = createUiStore({ frameMs: 1 });
  const controller = createUiController(session, store, { exit: () => {} });
  return { session, store, controller, provider, workspace };
}

const report = () => toolCallScript('report', 'report', { status: 'done', summary: 'research findings' });
const approvalCommand = (name: string) => toolCallScript('shell', 'bash', { command: `node -e "console.log('${name}')"` });
const result = (provider: RoutedProvider, id: string) => JSON.stringify(provider.requests.filter((r) => r.agent === id)[1]?.req.messages);

describe('swarm user approval', () => {
  it('queues concurrent scout requests in Mission Control and resumes the agent the user approves', async () => {
    const { session, store, controller, provider } = await setup({ s1: [approvalCommand('approved-scout'), report(), textScript('done')], s2: [approvalCommand('denied-scout'), report(), textScript('done')] });
    const view = render(<MissionControl session={session} store={store} controller={controller} onExit={() => {}} />);
    try {
      controller.submit('research', 'research');
      await vi.waitFor(() => expect(session.broker.pending()).toHaveLength(2));
      expect(session.swarm.info('s1')).toMatchObject({ state: 'waiting', waitingFor: '等待用户授权' });
      expect(session.swarm.info('s2')).toMatchObject({ state: 'waiting', waitingFor: '等待用户授权' });
      await vi.waitFor(() => expect(view.lastFrame()).toContain('需要确认'));
      const allowed = session.broker.pending()[0]!.agentId;
      const denied = session.broker.pending()[1]!.agentId;
      expect(provider.requests.filter((r) => r.agent === allowed)).toHaveLength(1);
      view.stdin.write('1');
      await vi.waitFor(() => expect(session.broker.pending()).toHaveLength(1));
      await vi.waitFor(() => expect(view.lastFrame()).toContain(`agent ${denied}`));
      view.stdin.write('4');
      await controller.whenIdle(); await session.swarm.whenIdle();
      expect(result(provider, allowed)).toContain(allowed === 's1' ? 'approved-scout' : 'denied-scout');
      expect(result(provider, allowed)).not.toContain('执行被拒绝');
      expect(result(provider, denied)).toContain('用户拒绝');
      expect(session.broker.pending()).toEqual([]);
      store.flush(); expect(store.getState().meta.interactions).toEqual([]);
      expect(store.getState().meta.messages.filter((m) => m.kind === 'alert')).toEqual([]);
    } finally { view.unmount(); controller.dispose(); await session.shutdown(); }
  }, 20_000);

  it('removes a cancelled child approval immediately while Queen keeps running', async () => {
    const { session, store, controller } = await setup({ s1: [approvalCommand('cancelled'), report(), textScript('done')] });
    const view = render(<App session={session} store={store} controller={controller} />);
    try {
      controller.submit('research', 'research');
      await vi.waitFor(() => expect(session.broker.pending()).toHaveLength(1));
      await vi.waitFor(() => expect(view.lastFrame()).toContain('agent s1'));
      controller.cancelAgent('s1');
      await vi.waitFor(() => expect(store.getState().meta.interactions).toEqual([]));
      expect(session.broker.pending()).toEqual([]);
      await controller.whenIdle();
      expect(session.swarm.info('s1')?.state).toBe('cancelled');
    } finally { view.unmount(); controller.dispose(); await session.shutdown(); }
  }, 20_000);

  it('runs long research without false stall alerts and still blocks direct scout file writes', async () => {
    const reads = Array.from({ length: 15 }, (_, i) => toolCallScript(`read${i}`, 'read', { path: `src/${i}.ts` }));
    const { session, store, controller, workspace, provider } = await setup({ s1: [...reads, toolCallScript('write', 'write', { path: 'changed.txt', content: 'no' }), report(), textScript('done')] });
    for (let i = 0; i < 15; i++) workspace.file(`src/${i}.ts`, `source ${i}`);
    try {
      controller.submit('research', 'research');
      await controller.whenIdle(); await session.swarm.whenIdle(); store.flush();
      expect(store.getState().meta.messages.filter((m) => m.kind === 'alert')).toEqual([]);
      expect(existsSync(join(workspace.dir, 'changed.txt'))).toBe(false);
      expect(JSON.stringify(provider.requests.filter((r) => r.agent === 's1')[16]?.req.messages)).toContain('只读');
      expect(session.swarm.info('s1')?.report?.summary).toBe('research findings');
    } finally { controller.dispose(); await session.shutdown(); }
  }, 20_000);
});
