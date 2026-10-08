import { describe, expect, it, vi } from 'vitest';
import { createSession } from '../../src/agent/session.js';
import { ConfigSchema } from '../../src/core/config.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import { runHeadless } from '../../src/cli/headless.js';
import { ScriptedProvider } from '../fixtures/scripted-provider.js';
import { RoutedProvider } from '../fixtures/routed-provider.js';
import { errorScript, textScript, toolCallScript, usageOf } from '../fixtures/chunks.js';
import { tempWorkspace } from '../fixtures/workspace.js';

const config = ConfigSchema.parse({
  providers: {
    p: {
      driver: 'openai-compat',
      auth: 'none',
      models: { m: { pricing: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 } }, unknown: {} },
    },
  },
  default: 'p:m',
  swarm: { worktrees: false },
});
async function start(provider: ScriptedProvider | RoutedProvider, opts: Parameters<typeof createSession>[0] = {}) {
  const ws = tempWorkspace(),
    providers = new ProviderRegistry();
  providers.register('p', provider);
  const session = await createSession({ cwd: ws.dir, config, providers, ...opts });
  let out = '',
    err = '';
  const controller = new AbortController();
  return {
    session,
    ws,
    controller,
    out: () => out,
    err: () => err,
    options: {
      format: 'json',
      controller,
      out: {
        write: (text: string) => {
          out += text;
        },
      },
      err: {
        write: (text: string) => {
          err += text;
        },
      },
    },
  };
}
describe('headless result and budget', () => {
  it.each(['success', 'error', 'aborted', 'max-steps'] as const)('emits exactly one result line for %s', async (subtype) => {
    const script =
      subtype === 'error'
        ? errorScript('INVALID_REQUEST')
        : subtype === 'max-steps'
          ? toolCallScript('read', 'read', { path: 'a.txt' })
          : textScript('本轮结果', usageOf(10, 5, 3, 2));
    const h = await start(new ScriptedProvider([script]), { maxSteps: 1 });
    h.ws.file('a.txt', 'text');
    if (subtype === 'aborted') h.controller.abort();
    const code = await runHeadless(h.session, 'hello', h.options),
      result = JSON.parse(h.out());
    expect(h.out().trim().split('\n')).toHaveLength(1);
    expect(result.subtype).toBe(subtype);
    expect(code).toBe(subtype === 'success' ? 0 : subtype === 'aborted' ? 130 : 1);
    if (subtype === 'success')
      expect(result).toMatchObject({
        result: '本轮结果',
        usage: usageOf(10, 5, 3, 2),
        costUsd: expect.any(Number),
        steps: 1,
        model: 'p:m',
      });
    if (subtype === 'error') expect(result.error).toMatchObject({ code: 'INVALID_REQUEST' });
    else expect(result.error).toBeUndefined();
  });
  it('aggregates generation and summary entries once, without counting turn totals again', async () => {
    const h = await start(new ScriptedProvider([textScript('done', usageOf(10, 5, 3, 2))]));
    h.session.loop.committer.commit({
      type: 'context/compact',
      at: '',
      upTo: 0,
      summary: '',
      auxUsage: usageOf(2, 1, 4),
      auxModel: { provider: 'p', model: 'm' },
    });
    expect(await runHeadless(h.session, 'hello', h.options)).toBe(0);
    expect(JSON.parse(h.out()).usage).toEqual(usageOf(12, 6, 7, 2));
  });
  it('keeps the last committed text when the final step only calls a tool, and preserves unknown costs', async () => {
    const script = [
      ...textScript('last text').slice(0, 3),
      ...toolCallScript('read', 'read', { path: 'a.txt' }).map((chunk) =>
        'index' in chunk ? { ...chunk, index: chunk.index + 1 } : chunk,
      ),
    ];
    const h = await start(new ScriptedProvider([script, toolCallScript('read2', 'read', { path: 'a.txt' })]), {
      modelRef: 'p:unknown',
      maxSteps: 2,
    });
    h.ws.file('a.txt', 'text');
    await runHeadless(h.session, 'read', h.options);
    expect(JSON.parse(h.out())).toMatchObject({ subtype: 'max-steps', result: 'last text', costUsd: null });
  });
  it('counts summary usage during a running request when enforcing the budget', async () => {
    const provider = new ScriptedProvider([
      () => {
        h.session.loop.committer.commit({
          type: 'context/compact',
          at: '',
          upTo: 0,
          summary: '',
          auxUsage: usageOf(1_000_000, 1),
          auxModel: { provider: 'p', model: 'm' },
        });
        return textScript('unused');
      },
    ]);
    const h = await start(provider);
    expect(await runHeadless(h.session, 'hello', { ...h.options, budget: 0.5 })).toBe(1);
    expect(JSON.parse(h.out())).toMatchObject({ subtype: 'budget', usage: usageOf(1_000_000, 1) });
    expect(h.err()).toContain('error [BUDGET]');
  });
  it.each([false, true])(
    'aborts main and cancels members when child usage exceeds budget or lacks pricing (unknown=%s)',
    async (unknown) => {
      const provider = new RoutedProvider({
        main: [
          toolCallScript(
            'spawn',
            'spawn_agent',
            { role: 'worker', task: 'work', ...(unknown ? { model: 'p:unknown' } : {}) },
            usageOf(1, 1),
          ),
          textScript('main'),
        ],
        w1: [textScript('child', usageOf(1_000_000, 500_000))],
      });
      const h = await start(provider),
        cancel = vi.spyOn(h.session.swarm, 'cancelSubtree');
      expect(await runHeadless(h.session, 'work', { ...h.options, budget: 1 })).toBe(1);
      const result = JSON.parse(h.out());
      expect(result.subtype).toBe('budget');
      expect(result.error.code).toBe('BUDGET');
      expect(h.err()).toContain('error [BUDGET]');
      expect(cancel).toHaveBeenCalled();
      expect(
        h.session.swarm
          .tree()
          .filter((a) => a.parentId)
          .every((a) => ['cancelled', 'done'].includes(a.state)),
      ).toBe(true);
      if (unknown) expect(result.costUsd).toBeNull();
    },
  );
  it('refuses to start a budget without main model pricing', async () => {
    const provider = new ScriptedProvider([textScript('unused')]),
      h = await start(provider, { modelRef: 'p:unknown' });
    expect(await runHeadless(h.session, 'hello', { ...h.options, budget: 1 })).toBe(1);
    expect(JSON.parse(h.out())).toMatchObject({
      subtype: 'error',
      error: { code: 'INVALID_REQUEST', message: '当前模型缺少定价，无法执行预算限制' },
    });
    expect(provider.requests).toHaveLength(0);
  });
  it('keeps process tool rules out of logs and enforces deny even if also allowed', async () => {
    const provider = new ScriptedProvider([toolCallScript('r', 'read', { path: 'a.txt' }), textScript('done')]);
    const h = await start(provider, { allowedTools: ['read(*)'], disallowedTools: ['read(a.txt)', 'web_*'] });
    h.ws.file('a.txt', 'text');
    await runHeadless(h.session, 'read', h.options);
    expect(provider.requests[0]!.tools?.some((tool) => tool.name === 'web_fetch')).toBe(false);
    const events = h.session.displayEvents();
    expect(events.find((event) => event.type === 'tool/result')).toMatchObject({ isError: true });
    expect(events.filter((event) => event.type === 'permission/grant')).toEqual([]);
    expect(JSON.stringify(events)).not.toContain('read(*)');
  });
});
