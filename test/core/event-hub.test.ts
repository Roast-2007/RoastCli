import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventHub } from '../../src/core/event-hub.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('EventHub', () => {
  it('同一窗口内的事件合批投递（约 30Hz）', () => {
    const hub = new EventHub<string>({ batchMs: 33 });
    const batches: string[][] = [];
    hub.subscribe(null, (b) => batches.push(b.map((e) => e.event)));
    hub.publish('main', 'a');
    hub.publish('main', 'b');
    expect(batches).toEqual([]);
    vi.advanceTimersByTime(33);
    expect(batches).toEqual([['a', 'b']]);
    hub.publish('main', 'c');
    vi.advanceTimersByTime(33);
    expect(batches).toEqual([['a', 'b'], ['c']]);
  });

  it('按过滤器分发，带 agentId', () => {
    const hub = new EventHub<number>({ batchMs: 10 });
    const got: string[] = [];
    hub.subscribe((e) => e.agentId === 'w1', (b) => got.push(...b.map((e) => `${e.agentId}:${e.event}`)));
    hub.publish('main', 1);
    hub.publish('w1', 2);
    vi.advanceTimersByTime(10);
    expect(got).toEqual(['w1:2']);
  });

  it('退订后不再收到；flush 立即投递', () => {
    const hub = new EventHub<number>({ batchMs: 1000 });
    const got: number[] = [];
    const off = hub.subscribe(null, (b) => got.push(...b.map((e) => e.event)));
    hub.publish('main', 1);
    hub.flush();
    expect(got).toEqual([1]);
    off();
    hub.publish('main', 2);
    hub.flush();
    expect(got).toEqual([1]);
  });

  it('订阅者抛错不影响其他订阅者', () => {
    const hub = new EventHub<number>({ batchMs: 5 });
    const got: number[] = [];
    hub.subscribe(null, () => {
      throw new Error('boom');
    });
    hub.subscribe(null, (b) => got.push(...b.map((e) => e.event)));
    hub.publish('main', 7);
    vi.advanceTimersByTime(5);
    expect(got).toEqual([7]);
  });
});
