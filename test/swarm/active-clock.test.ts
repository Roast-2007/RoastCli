import { describe, expect, it, vi } from 'vitest';
import { ActiveClock } from '../../src/swarm/active-clock.js';

describe('用户交互暂停时钟', () => {
  it('计时预算扣除重叠暂停，恢复后继续剩余时间', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const clock = new ActiveClock(Date.now),
        done = vi.fn();
      const stop = clock.timeout(0, 1000, done);
      await vi.advanceTimersByTimeAsync(300);
      clock.setPaused(true);
      await vi.advanceTimersByTimeAsync(5000);
      expect(done).not.toHaveBeenCalled();
      expect(clock.elapsed(0)).toBe(300);
      expect(clock.elapsed(500)).toBe(0);
      clock.setPaused(false);
      await vi.advanceTimersByTimeAsync(699);
      expect(done).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toHaveBeenCalledOnce();
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
