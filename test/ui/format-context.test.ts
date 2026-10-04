import { describe, expect, it } from 'vitest';
import { formatContextStats, gauge } from '../../src/ui/format-context.js';

describe('formatContextStats', () => {
  it('量规与分类明细', () => {
    expect(gauge(50, 10)).toBe('▰▰▰▰▰▱▱▱▱▱');
    const text = formatContextStats({
      window: 20000,
      estimated: 7600,
      percent: 38,
      breakdown: { overhead: 1200, user: 800, assistant: 1100, toolResults: 4300, summary: 200 },
      elidedCount: 3,
      compactedUpTo: 12,
      calibration: 1.05,
      anchored: true,
      largest: [
        { id: 'c1', name: 'read', path: 'src/big.ts', tokens: 3000, elided: false, pinned: true },
        { id: 'c2', name: 'bash', tokens: 900, elided: true, pinned: false },
      ],
    });
    expect(text).toContain('📌 c1  read src/big.ts  3,000');
    expect(text).toContain('◌ c2  bash  900（已折叠）');
    expect(text).toContain('上下文 38%');
    expect(text).toContain('7,600 / 20,000');
    expect(text).toContain('已折叠 3 项');
    expect(text).toContain('已压缩前 12 条消息');
    expect(text).toContain('×1.05');
  });
});
