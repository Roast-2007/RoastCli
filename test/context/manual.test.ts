/**
 * /context pin | unpin | drop：手动调整落日志，下一次请求的视图随之变化，回放一致；钉住的结果不会被策略折叠。
 */
import { describe, expect, it } from 'vitest';
import { createSession } from '../../src/agent/session.js';
import type { RoastConfig } from '../../src/core/config.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import { dedupCandidates } from '../../src/context/policies.js';
import { applyContextEvent, initialContext } from '../../src/context/state.js';
import { ScriptedProvider } from '../fixtures/scripted-provider.js';
import { textScript, toolCallScript } from '../fixtures/chunks.js';
import { replayMismatches } from '../fixtures/replay.js';
import { tempWorkspace } from '../fixtures/workspace.js';

const config: RoastConfig = {
  providers: { p: { driver: 'openai-compat', apiKeyEnv: 'UNUSED' } },
  default: 'p:m',
  maxSteps: 10,
  logsDir: 'logs',
  debugLog: false,
  context: {},
  swarm: { maxAgents: 12, maxDepth: 3, maxMinutes: 60 },
};

async function drain(gen: AsyncGenerator<unknown>): Promise<void> {
  for await (const _ of gen);
}

describe('manual context actions', () => {
  it('drop folds a result in the next request, pin restores and protects it; replay stays consistent', async () => {
    const ws = tempWorkspace();
    ws.file('a.txt', 'alpha '.repeat(200));
    const provider = new ScriptedProvider([
      toolCallScript('r1', 'read', { path: 'a.txt' }),
      textScript('读完了'),
      textScript('第二轮'),
      toolCallScript('r2', 'read', { path: 'a.txt' }),
      textScript('又读了一次'),
    ]);
    const providers = new ProviderRegistry();
    providers.register('p', provider);
    const session = await createSession({ cwd: ws.dir, config, providers });
    await drain(session.loop.run('读 a.txt'));

    expect(session.contextStats().largest.map((x) => x.id)).toContain('r1');
    expect(session.contextAction('drop', ['nope'])).toContain('没有这些工具结果');
    expect(session.contextAction('drop', ['r1'])).toContain('已折叠');
    await drain(session.loop.run('继续'));
    expect(JSON.stringify(provider.requests[2]!.messages)).toContain('⟦ctx:r1⟧');

    expect(session.contextAction('pin', ['r1'])).toContain('已钉住');
    expect(session.contextStats().largest.find((x) => x.id === 'r1')).toMatchObject({ pinned: true, elided: false });
    await drain(session.loop.run('再读一次'));
    expect(dedupCandidates(session.loop.committer.state)).not.toContain('r1');
    expect(JSON.stringify(provider.requests[3]!.messages)).not.toContain('⟦ctx:r1⟧');

    await session.shutdown();
    expect(replayMismatches(session.log.path)).toEqual([]);
  });

  it('pin un-elides, unpin keeps content but allows folding again', () => {
    const ev = (ops: unknown[]) => ({ type: 'context/transform', at: '', ops }) as never;
    let ctx = applyContextEvent(initialContext(), ev([{ op: 'elide', ids: ['a', 'b'], reason: 'x' }]), 0);
    ctx = applyContextEvent(ctx, ev([{ op: 'pin', ids: ['a'] }]), 0);
    expect(Object.keys(ctx.elided)).toEqual(['b']);
    expect(ctx.pinned).toEqual({ a: true });
    ctx = applyContextEvent(ctx, ev([{ op: 'unpin', ids: ['a'] }]), 0);
    expect(ctx.pinned).toEqual({});
    expect(Object.keys(ctx.elided)).toEqual(['b']);
  });
});
