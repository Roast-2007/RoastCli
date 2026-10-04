import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderLimiter, scheduledAdapter } from '../../src/providers/scheduler.js';
import { RoastError } from '../../src/core/errors.js';
import { ScriptedProvider } from '../fixtures/scripted-provider.js';
import { textScript, errorScript } from '../fixtures/chunks.js';

afterEach(() => vi.useRealTimers());
describe('adaptive provider concurrency', () => {
  it('halves concurrency on 429, honors shared cooldown, recovers after ten successes and removes cancelled waiters', async () => {
    vi.useFakeTimers();
    const limiter = new ProviderLimiter(8);
    const releases = await Promise.all(Array.from({ length: 4 }, () => limiter.acquire()));
    const signal = new AbortController();
    const cancelled = limiter.acquire(signal.signal); const rejection = expect(cancelled).rejects.toMatchObject({ code: 'ABORTED' });
    signal.abort(); await rejection;
    releases[0]!(new RoastError('RATE_LIMIT', 'busy', { retryAfterMs: 1000 }));
    releases.slice(1).forEach((release) => release());
    expect(limiter.stats).toMatchObject({ limit: 2, active: 0, queued: 0 });
    let started = false;
    const pending = limiter.acquire().then((release) => { started = true; return release; });
    await vi.advanceTimersByTimeAsync(999); expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(1); (await pending)(undefined, true);
    for (let i = 0; i < 9; i++) (await limiter.acquire())(undefined, true);
    expect(limiter.stats.limit).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('queues streams independently per provider, releases on early close and never calls the adapter for an aborted request', async () => {
    const source = new ScriptedProvider([textScript('first'), errorScript('RATE_LIMIT', 'busy'), textScript('third')]);
    const limiter = new ProviderLimiter(1);
    const adapter = scheduledAdapter(source, limiter);
    const first = adapter.stream({ model: 'm', messages: [] })[Symbol.asyncIterator]();
    await first.next(); expect(limiter.stats.active).toBe(1);
    const signal = new AbortController(); signal.abort();
    const chunks = [];
    for await (const chunk of adapter.stream({ model: 'm', messages: [], signal: signal.signal })) chunks.push(chunk);
    expect(chunks).toEqual([expect.objectContaining({ type: 'finish', reason: 'aborted' })]);
    expect(source.requests).toHaveLength(1);
    await first.return?.(); expect(limiter.stats.active).toBe(0);
    const separate = new ProviderLimiter(1); (await separate.acquire())();
    expect(separate.stats.active).toBe(0);
  });
});
