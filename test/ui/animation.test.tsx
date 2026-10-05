import { render } from 'ink-testing-library';
import { Box, Text } from 'ink';
import { describe, expect, it, vi } from 'vitest';
import { useSpinner } from '../../src/ui/components/useSpinner.js';
import { TerminalContext, terminalPreferences } from '../../src/ui/terminal.js';
import { TodoPanel, Gauge } from '../../src/ui/components/Chrome.js';
import { Markdown } from '../../src/ui/markdown/Markdown.js';
import { useEntrance } from '../../src/ui/motion.js';
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
function Spinner() { return <Text>{useSpinner(true)}</Text>; }
function Entrance() { return <Text>{useEntrance('panel')}</Text>; }
describe('terminal motion', () => {
  it('ASCII mode replaces decorative frames, task marks and context gauges', async () => {
    const screen = render(<TerminalContext.Provider value={{ motion: false, ascii: true }}><Box flexDirection="column"><TodoPanel todos={[{ content: 'task', status: 'pending' }]} /><Gauge percent={50} width={4} /><Markdown text={'```txt\ncode\n```\n\n- [x] done'} /></Box></TerminalContext.Provider>);
    try { await tick(); expect(screen.lastFrame()).toContain('+'); expect(screen.lastFrame()).toContain('[ ] task'); expect(screen.lastFrame()).toContain('##-- 50%'); expect(screen.lastFrame()).toContain('[x] done'); expect(screen.lastFrame()).not.toMatch(/[╭╮╰╯─│▰▱☑☐]/); }
    finally { screen.unmount(); }
  });
  it('twenty animations share a clock, stay in sync, and stop after unmount', async () => {
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const clear = vi.spyOn(globalThis, 'clearInterval');
    const screen = render(<TerminalContext.Provider value={{ motion: true, ascii: false }}><Box>{Array.from({ length: 20 }, (_, i) => <Spinner key={i} />)}</Box></TerminalContext.Provider>);
    try {
      await tick(130);
      expect(intervals.mock.calls.filter((call) => call[1] === 80)).toHaveLength(1);
      expect(new Set(screen.lastFrame()!.trim()).size).toBe(1);
      screen.unmount(); await tick();
      expect(clear).toHaveBeenCalled();
    } finally { screen.unmount(); intervals.mockRestore(); clear.mockRestore(); }
  });
  it('reduced motion and dumb terminals never schedule animation ticks', async () => {
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const screen = render(<TerminalContext.Provider value={terminalPreferences({ TERM: 'dumb' })}><Box><Spinner /><Entrance /></Box></TerminalContext.Provider>);
    try { await tick(100); expect(screen.lastFrame()).toBe('|1'); expect(intervals.mock.calls.filter((call) => call[1] === 80 || call[1] === 32)).toHaveLength(0); }
    finally { screen.unmount(); intervals.mockRestore(); }
  });
});
