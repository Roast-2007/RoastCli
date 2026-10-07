import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { ctrlC } from '../../../src/ui/hive/interrupt.js';
import { cachePercent, statusText } from '../../../src/ui/hive/status.js';
import { Ignition, IGNITION_MS, ignitionSize } from '../../../src/ui/hive/Ignition.js';
import { TerminalContext } from '../../../src/ui/terminal.js';
import { ThemeContext, THEMES } from '../../../src/ui/theme.js';
import { emptyUsage } from '../../../src/core/types.js';
import type { Session } from '../../../src/agent/session.js';
import { screenOf } from './vt.js';
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
// Waits for the real 900ms ignition; hosted runners with coverage can exceed the default 5s.
describe('quiet Hive chrome', { timeout: 20_000 }, () => {
  it('prioritizes interruption, clears a draft and arms exit for exactly two seconds', () => {
    expect(ctrlC(true, 'draft', 100, 200)).toEqual({ action: 'interrupt', armedAt: null });
    expect(ctrlC(false, 'draft', null, 100)).toEqual({ action: 'clear', armedAt: 100 });
    expect(ctrlC(false, '', null, 100)).toEqual({ action: 'hint', armedAt: 100 });
    expect(ctrlC(false, '', 100, 2100).action).toBe('exit');
    expect(ctrlC(false, '', 100, 2101).action).toBe('hint');
  });
  it('weights cache tokens, includes cache writes in input and removes facts in order', () => {
    expect(cachePercent({ ...emptyUsage(), input: 100, cacheRead: 800, cacheWrite: 100 })).toBe(80);
    expect(cachePercent(emptyUsage())).toBeNull();
    const p = { percent: 25, total: { ...emptyUsage(), input: 1000, output: 200, cacheRead: 4000 }, cost: '$0.08', branch: 'main', activity: '', separator: '|', up: '^', down: 'v', branchGlyph: '@', ascii: true };
    const full = statusText(120, 6, p).left; expect(full).toContain('main'); expect(full).toContain('缓存 80%'); expect(full).toContain('^5.0k');
    const states = Array.from({ length: 100 }, (_, index) => statusText(120 - index, 6, p).left);
    const disappears = (text: string) => states.findIndex((value) => !value.includes(text));
    expect(disappears('main')).toBeLessThan(disappears('缓存'));
    expect(disappears('缓存')).toBeLessThan(disappears('^5.0k'));
    expect(disappears('^5.0k')).toBeLessThan(disappears('$0.08'));
    expect(statusText(120, 6, { ...p, cost: null }).left).toContain('未知');
  });
  it('uses exact size fallbacks and completes the monochrome animation at 900ms', async () => {
    expect(ignitionSize(64, 18)).toBe('M'); expect(ignitionSize(60, 12)).toBe('S'); expect(ignitionSize(80, 6)).toBe('line'); expect(ignitionSize(23, 20)).toBe('tiny');
    vi.useFakeTimers();
    const done = vi.fn(), session = { log: { header: { cwd: process.cwd() } }, config: { swarm: { maxAgents: 12 } }, providerName: 'p', model: 'm' } as Session;
    const screen = render(<TerminalContext.Provider value={{ motion: true, ascii: true }}><ThemeContext.Provider value={THEMES.mono!}><Ignition session={session} height={23} columns={80} onDone={done} onExit={() => {}} /></ThemeContext.Provider></TerminalContext.Provider>);
    try {
      await vi.advanceTimersByTimeAsync(IGNITION_MS - 1); expect(done).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1); expect(done).toHaveBeenCalledTimes(1);
      const shown = screenOf(screen.frames, 80, 23).join('\n');
      expect(shown).not.toMatch(/任意键|正在进入/);
      expect(shown).toContain('H   I   V   E');
      // Monochrome keeps bold/dim only: no colour codes reach the terminal.
      expect(screen.frames.join('')).not.toMatch(/\x1b\[[\d;]*(?:38;[25];|3[0-7]m|9[0-7]m)/);
    } finally { screen.unmount(); vi.useRealTimers(); }
    await tick();
  });
});
