/**
 * FakeClock：sleep 立即完成（不真睡），记录每次等待时长；now 随 sleep 推进。
 */
import type { Clock } from '../../src/agent/retry.js';

export class FakeClock implements Clock {
  readonly sleeps: number[] = [];
  private t = Date.parse('2026-01-01T00:00:00Z');

  now(): number {
    return this.t;
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.t += ms;
  }
}
