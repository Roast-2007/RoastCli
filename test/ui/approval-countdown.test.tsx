import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { createSession } from '../../src/agent/session.js';
import type { InteractionRequest } from '../../src/core/interaction.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import { InteractionCard } from '../../src/ui/components/InteractionCard.js';
import { createUiController } from '../../src/ui/controller.js';
import { createUiStore } from '../../src/ui/store/store.js';
import { ScriptedProvider } from '../fixtures/scripted-provider.js';
import { tempWorkspace } from '../fixtures/workspace.js';

const tick = () => new Promise((r) => setTimeout(r, 20));
const config = {
  providers: { p: { driver: 'openai-compat' as const, auth: 'none' as const } },
  default: 'p:m',
  maxSteps: 10,
  logsDir: 'logs',
  debugLog: false,
  context: {},
  swarm: { maxAgents: 12, maxDepth: 3, maxMinutes: 60 },
};

describe('帮我审批：界面中的倒计时', () => {
  it('broker 变化时保留界面中的审批顺序，提到最前的审批开始倒计时后不会被换回去', async () => {
    const providers = new ProviderRegistry();
    providers.register('p', new ScriptedProvider([]));
    const session = await createSession({ cwd: tempWorkspace().dir, providers, config });
    const store = createUiStore();
    const controller = createUiController(session, store, { exit() {} });
    const abort = new AbortController();
    const ask = (title: string) =>
      session.broker.request({ kind: 'permission', agentId: 'main', tool: 'bash', title, reason: 'r', countdownMs: 10_000 }, abort.signal);
    const pending = [ask('a'), ask('b')];
    try {
      const [first, second] = store.getState().meta.interactions;
      store.setMeta({ interactions: [second!, first!] });
      controller.showInteraction(second!.id);
      const shown = store.getState().meta.interactions;
      expect(shown.map((r) => (r.kind === 'permission' ? r.title : ''))).toEqual(['b', 'a']);
      expect(shown[0]!.deadline).toBeTypeOf('number');
      expect(shown[1]!.deadline).toBeUndefined();
    } finally {
      abort.abort();
      await Promise.allSettled(pending);
      controller.dispose();
      await session.shutdown();
    }
  });

  it('卡片未作答就被移走时暂停倒计时，作答后移走不暂停', async () => {
    const request: InteractionRequest = {
      id: 'p1',
      kind: 'permission',
      agentId: 'main',
      tool: 'bash',
      title: 'bash: git push',
      reason: '高风险操作：推送到远端仓库',
      countdownMs: 10_000,
      deadline: Date.now() + 9_000,
    };
    const onHold = vi.fn();
    const moved = render(<InteractionCard request={request} onRespond={vi.fn()} onHold={onHold} />);
    await tick();
    moved.unmount();
    expect(onHold).toHaveBeenCalledOnce();

    const answeredHold = vi.fn();
    const answered = render(<InteractionCard request={{ ...request, id: 'p2' }} onRespond={vi.fn()} onHold={answeredHold} />);
    await tick();
    answered.stdin.write('4');
    await tick();
    answeredHold.mockClear();
    answered.unmount();
    expect(answeredHold).not.toHaveBeenCalled();
  });
});
