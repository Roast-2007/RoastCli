import { describe, expect, it } from 'vitest';
import { runStep } from '../../src/agent/step.js';
import { DEFAULT_RETRY } from '../../src/agent/retry.js';
import { RoastError } from '../../src/core/errors.js';
import type { SessionEvent, SessionEventBody } from '../../src/session/events.js';
import { ScriptedProvider } from '../fixtures/scripted-provider.js';
import { textScript, usageOf } from '../fixtures/chunks.js';

describe('model step retries and cancellation', () => {
  it('resets partial output, retains billed retry usage and returns only the successful message', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'text-delta', index: 0, text: 'partial' },
        { type: 'usage', usage: usageOf(30, 2) },
        { type: 'finish', reason: 'error', error: new RoastError('SERVER', 'retry', { retryable: true }) },
      ],
      textScript('complete', usageOf(20, 5)),
    ]);
    const events: SessionEvent[] = [],
      ui: string[] = [],
      waits: number[] = [];
    const commit = (body: SessionEventBody) => {
      const event = { ...body, seq: events.length + 1, agentId: 'main' };
      events.push(event);
      return event;
    };
    const step = runStep(
      { model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'task' }] }] },
      {
        adapter: provider,
        retry: { ...DEFAULT_RETRY, jitter: 0 },
        clock: {
          now: () => 0,
          sleep: async (ms) => {
            waits.push(ms);
          },
        },
        debugLog: false,
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
        commit,
      },
    );
    let next = await step.next();
    while (!next.done) {
      ui.push(next.value.type);
      next = await step.next();
    }
    expect(next.value).toMatchObject({
      kind: 'message',
      usage: usageOf(50, 7),
      message: { content: [{ type: 'text', text: 'complete' }] },
    });
    expect(ui).toContain('stream-reset');
    expect(waits).toEqual([1000]);
    expect(events.filter((e) => e.type === 'usage')).toHaveLength(2);
  });
  it('stops during retry delay without opening another model request', async () => {
    const abort = new AbortController();
    const provider = new ScriptedProvider([
      [
        { type: 'usage', usage: usageOf(10, 0) },
        { type: 'finish', reason: 'error', error: new RoastError('RATE_LIMIT', 'limited', { retryable: true }) },
      ],
      textScript('must not run'),
    ]);
    let seq = 0;
    const step = runStep(
      { model: 'm', messages: [] },
      {
        adapter: provider,
        retry: DEFAULT_RETRY,
        clock: {
          now: () => 0,
          sleep: async () => {
            abort.abort();
          },
        },
        debugLog: false,
        turn: 1,
        step: 1,
        signal: abort.signal,
        commit: (body) => ({ ...body, seq: ++seq, agentId: 'main' }),
      },
    );
    let next = await step.next();
    while (!next.done) next = await step.next();
    expect(next.value).toMatchObject({ kind: 'failed', aborted: true, usage: usageOf(10, 0) });
    expect(provider.requests).toHaveLength(1);
  });
});
