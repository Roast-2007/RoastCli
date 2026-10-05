import { describe, expect, it } from 'vitest';
import { buildMessages } from '../../src/providers/openai-compat/request.js';
import { buildRequest as anthropicRequest } from '../../src/providers/anthropic/request.js';
import { mapUsage } from '../../src/providers/openai-compat/translate.js';
import { ContextController } from '../../src/context/controller.js';
import { applyHistory, initialHistory } from '../../src/session/history.js';
import { userMessage, type Message } from '../../src/core/types.js';

describe('cache prefix preservation and accounting', () => {
  it('keeps the exact serialized old prefix after a new turn or a textual inbox attachment', () => {
    const old: Message[] = [
      userMessage('goal'),
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'analysis' },
          { type: 'tool-call', id: 'r', name: 'read', args: { path: 'x' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'r', name: 'read', content: [{ type: 'text', text: 'x' }] }] },
    ];
    const before = buildMessages(old, 'field');
    const next = [...old, { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'done' }] }, userMessage('next')];
    expect(buildMessages(next, 'field').slice(0, before.length)).toEqual(before);
    expect(
      buildMessages(
        [...old.slice(0, -1), { role: 'user', content: [...old.at(-1)!.content, { type: 'text', text: 'new inbox' }] }],
        'field',
      ).slice(0, 2),
    ).toEqual(before.slice(0, 2));
  });
  it('maps DeepSeek misses once, including endpoints that omit prompt_tokens', () => {
    const usage = mapUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 });
    expect(usage.input + usage.cacheRead + usage.cacheWrite).toBe(100);
    expect(mapUsage({ prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 })).toEqual(usage);
  });
  it('marks the previous Anthropic request boundary plus the tail within four breakpoints', () => {
    const request = anthropicRequest(
      {
        model: 'm',
        system: 'stable',
        messages: [userMessage('q1'), { role: 'assistant', content: [{ type: 'text', text: 'a1' }] }, userMessage('q2')],
        cacheBoundary: 1,
        tools: [{ name: 'read', description: 'read', parameters: {} }],
      },
      { promptCaching: true },
    );
    expect(JSON.stringify(request).match(/cache_control/g)).toHaveLength(4);
    expect((request['messages'] as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content[0]).toHaveProperty('cache_control');
  });
  it('anchors appended blocks in a trailing user message and reports token-weighted cache hits', () => {
    let state = applyHistory(initialHistory(), { type: 'user/message', turn: 1, at: '', message: userMessage('q') });
    const ctl = new ContextController({ window: 100_000, overhead: () => 100 });
    ctl.attach(
      (event) => {
        state = applyHistory(state, event);
      },
      () => state,
    );
    ctl.observe({
      type: 'request/digest',
      turn: 1,
      step: 1,
      at: '',
      model: 'm',
      systemHash: '',
      toolsHash: '',
      viewHash: '',
      messageCount: 1,
    });
    ctl.observe({ type: 'usage', turn: 1, step: 1, usage: { input: 20, output: 2, cacheRead: 80, cacheWrite: 0 } });
    const before = ctl.estimate(state);
    state = applyHistory(state, {
      type: 'attachment/injected',
      turn: 1,
      step: 2,
      at: '',
      source: 'inbox',
      blocks: [{ type: 'text', text: 'x'.repeat(2000) }],
    });
    expect(ctl.estimate(state)).toBeGreaterThan(before + 300);
    expect(ctl.stats(state).cache).toMatchObject({ requests: 1, read: 80, input: 100, hitRate: 0.8 });
    ctl.observe({ type: 'usage', turn: 1, step: 1, usage: { input: 20, output: 2, cacheRead: 80, cacheWrite: 0 } });
    expect(ctl.stats(state).cache?.input).toBe(100);
    ctl.observe({ type: 'step/retry', turn: 1, step: 1, at: '', attempt: 1, code: 'SERVER', message: 'retry', delayMs: 1000 });
    expect(ctl.stats(state).cache?.requests).toBe(1);
    ctl.observe({ type: 'usage', turn: 1, step: 1, usage: { input: 0, output: 2, cacheRead: 100, cacheWrite: 0 } });
    expect(ctl.stats(state).cache).toMatchObject({ requests: 2, read: 180, input: 200, hitRate: 0.9 });
  });
});
