/**
 * 性能：20 个 agent 同时流式输出时，store 合批把订阅通知压在 ~30 次/秒以内，归约本身的耗时可控。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUiStore } from '../../src/ui/store/store.js';

afterEach(() => {
  vi.useRealTimers();
});

const AGENTS = 20;
const DELTAS_PER_AGENT = 1000;
const SIM_MS = 1000;

describe('UI store under swarm load', () => {
  it('coalesces 20k events from 20 agents into at most ~30 notifications per second', () => {
    vi.useFakeTimers();
    const store = createUiStore({ frameMs: 33, now: () => Date.now() });
    let notifications = 0;
    store.subscribe(() => notifications++);
    for (let a = 0; a < AGENTS; a++) store.pushEvent(`w${a}`, { type: 'turn-start', turn: 1 });

    const started = performance.now();
    const perTick = (AGENTS * DELTAS_PER_AGENT) / SIM_MS;
    for (let ms = 0; ms < SIM_MS; ms++) {
      for (let i = 0; i < perTick; i++) {
        const agent = `w${(ms * perTick + i) % AGENTS}`;
        store.pushEvent(agent, { type: 'text-delta', text: i % 25 === 0 ? '段落结束。\n\n' : '一些流式输出文字 ' });
      }
      vi.advanceTimersByTime(1);
    }
    vi.advanceTimersByTime(100);
    const elapsed = performance.now() - started;

    expect(notifications).toBeLessThanOrEqual(Math.ceil(SIM_MS / 33) + 2);
    expect(notifications).toBeGreaterThan(10);
    const views = Object.values(store.getState().agents);
    expect(views.length).toBe(AGENTS + 1);
    expect(views.filter((v) => v.items.length > 0 || v.pending.length > 0)).toHaveLength(AGENTS);
    expect(elapsed).toBeLessThan(5_000);
  });
});
