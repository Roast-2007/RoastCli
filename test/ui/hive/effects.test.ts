import { describe, expect, it, vi } from 'vitest';
import { terminalEffects, notificationSequence } from '../../../src/ui/hive/terminal-effects.js';
import { createUiStore } from '../../../src/ui/store/store.js';
describe('terminal effects', () => {
  it('sends OSC9 only in supported terminals, with explicit bell/off and sanitized content', () => {
    for (const env of [{ WT_SESSION: '1' }, { TERM_PROGRAM: 'iTerm.app' }, { TERM_PROGRAM: 'WezTerm' }, { KITTY_WINDOW_ID: '1' }]) expect(notificationSequence('auto', env, 'approved\x07\x1b[31m')).toBe('\x1b]9;approved\x07');
    expect(notificationSequence('auto', {}, 'x')).toBe(''); expect(notificationSequence('off', { WT_SESSION: '1' }, 'x')).toBe(''); expect(notificationSequence('bell', {}, 'x')).toBe('\x07');
  });
  it('does not emit any terminal codes for pipes', () => {
    const write = vi.fn(), store = createUiStore(), effects = terminalEffects({ isTTY: false, write }, '/repo', {}, { WT_SESSION: '1' });
    effects.bind(store); store.setMeta({ running: true, interactions: [{ id: 'a', kind: 'permission', agentId: 'main', tool: 'bash', title: 'bash', reason: 'ask' }] }); effects.dispose(); expect(write).not.toHaveBeenCalled();
  });
  it('notifies once per approval, only after long runs, throttles title and resets it on exit', async () => {
    vi.useFakeTimers();
    const write = vi.fn(), store = createUiStore(), effects = terminalEffects({ isTTY: true, write }, '/repo', {}, { WT_SESSION: '1' });
    try {
      effects.bind(store); expect(write).toHaveBeenCalledWith('\x1b]2;roast · repo\x07');
      store.setMeta({ running: true }); store.setMeta({ contextPercent: 12 });
      expect(write.mock.calls.filter(([text]) => text.includes(']2;'))).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000); expect(write.mock.calls.filter(([text]) => text.includes(']2;'))).toHaveLength(2);
      const request = { id: 'a', kind: 'permission' as const, agentId: 'main', tool: 'bash', title: 'bash', reason: 'ask' };
      store.setMeta({ interactions: [request] }); store.setMeta({ interactions: [request] });
      expect(write.mock.calls.filter(([text]) => text.includes(']9;'))).toHaveLength(1);
      store.setMeta({ running: false }); expect(write.mock.calls.filter(([text]) => text.includes(']9;'))).toHaveLength(1);
      store.setMeta({ running: true }); await vi.advanceTimersByTimeAsync(20_000); store.setMeta({ running: false });
      expect(write).toHaveBeenCalledWith('\x1b]9;RoastCli：任务已结束\x07');
      effects.dispose(); expect(write.mock.calls.at(-1)).toEqual(['\x1b]2;roast\x07']);
      const count = write.mock.calls.length; await vi.advanceTimersByTimeAsync(2000); expect(write).toHaveBeenCalledTimes(count);
    } finally { effects.dispose(); vi.useRealTimers(); }
  });
});
