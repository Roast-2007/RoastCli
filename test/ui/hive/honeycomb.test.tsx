import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { displayWidth } from '../../../src/core/text-width.js';
import { generateHoneycomb, hiveGeometry, ignitionSize } from '../../../src/ui/hive/honeycomb.js';
import { BIG_ROAST_LOGO } from '../../../src/ui/hive/wordmark.js';
import { HIVE_SUBTITLE, ignitionCells, SETTLED_MS } from '../../../src/ui/hive/ignition-frame.js';
import { Ignition, IGNITION_MS } from '../../../src/ui/hive/Ignition.js';
import type { Session } from '../../../src/agent/session.js';
import { VERSION } from '../../../src/core/version.js';
import { clearsAreSynchronized, screenOf } from './vt.js';
// Literal golden fixtures copied from the revision's hand-drawn source.
const GOLDEN = [
  " _____     ____                 _____   _______ ",
  "|  __ \\   / __ \\       /\\      / ____| |__   __|",
  "| |__) | | |  | |     /  \\    | (___      | |   ",
  "|  _  /  | |  | |    / /\\ \\    \\___ \\     | |   ",
  "| | \\ \\  | |__| |   / ____ \\   ____) |    | |   ",
  "|_|  \\_\\  \\____/   /_/    \\_\\ |_____/     |_|   "
];
const SAMPLES = {
  "L": [
    "  ______          ______          ______",
    " /      \\        /      \\        /      \\",
    "/        \\______/        \\______/        \\______",
    "\\        /      \\        /      \\        /      \\",
    " \\______/        \\______/        \\______/        \\",
    " /      \\        /      \\        /      \\        /",
    "/        \\______/        \\______/        \\______/",
    "\\        /      \\        /      \\        /      \\",
    " \\______/        \\______/        \\______/        \\"
  ],
  "XL": [
    "   ________              ________",
    "  /        \\            /        \\",
    " /          \\          /          \\",
    "/            \\________/            \\________",
    "\\            /        \\            /        \\",
    " \\          /          \\          /          \\",
    "  \\________/            \\________/            \\",
    "  /        \\            /        \\            /",
    " /          \\          /          \\          /",
    "/            \\________/            \\________/"
  ],
  "M": [
    " ____      ____      ____",
    "/    \\____/    \\____/    \\____",
    "\\____/    \\____/    \\____/    \\",
    "/    \\____/    \\____/    \\____/",
    "\\____/    \\____/    \\____/    \\"
  ],
  "S": [
    " __    __    __",
    "/  \\__/  \\__/  \\__",
    "\\__/  \\__/  \\__/  \\",
    "/  \\__/  \\__/  \\__/"
  ]
};
// The ignition tests wait for the real 900ms animation; coverage and concurrent
// workers on hosted runners can push that past the default 5s.
describe('full-window ASCII honeycomb', { timeout: 20_000 }, () => {
  it('reproduces every source sample character and has no conflicting shared edges', () => {
    for (const tier of ['S', 'M', 'L', 'XL'] as const) {
      const sample = SAMPLES[tier];
      const grid = generateHoneycomb(100, sample.length, tier, { dx: 0, dy: 0, positiveOnly: true, checkConflicts: true }).grid;
      sample.forEach((line, row) => expect(grid[row]!.slice(0, line.length)).toBe(line));
      expect(() => generateHoneycomb(200, 60, tier, { checkConflicts: true })).not.toThrow();
    }
  });
  it('preserves all six 48-column wordmark rows including letter spacing', () => {
    expect(BIG_ROAST_LOGO).toEqual(GOLDEN);
    expect(BIG_ROAST_LOGO.map(line => line.length)).toEqual([48, 48, 48, 48, 48, 48]);
  });
  it('selects tiers at both dimension boundaries', () => {
    for (const [columns, rows, tier] of [[150,44,'XL'],[149,44,'L'],[150,43,'L'],[100,30,'L'],[99,30,'M'],[100,29,'M'],[64,18,'M'],[63,18,'S'],[64,17,'S'],[40,10,'S'],[39,10,'line'],[40,9,'line'],[24,3,'line'],[23,3,'tiny'],[24,2,'tiny']] as const) expect(ignitionSize(columns, rows)).toBe(tier);
  });
  it('caches geometry, clears the royal chamber and keeps a complete queen cell above it', () => {
    for (const [columns, rows] of [[64,18],[100,30],[200,60]] as const) {
      const g = hiveGeometry(columns, rows);
      expect(hiveGeometry(columns, rows)).toBe(g);
      for (let y = g.chamber.y; y < g.chamber.y + g.chamber.h; y++) {
        expect(g.grid[y]!.slice(g.chamber.x, g.chamber.x + g.chamber.w).trim()).toBe('');
        for (let x = g.chamber.x; x < g.chamber.x + g.chamber.w; x++) expect(g.cellAt[y * columns + x]).toBe(-1);
      }
      const queen = g.cells[g.queen!]!;
      expect(queen).toBeDefined();
      expect(queen.outline.every(([x,y]) => x >= 0 && x < columns && y >= 0 && y < g.chamber.y)).toBe(true);
      expect(Math.abs(queen.cx - columns / 2)).toBeLessThan(15);
    }
  });
  it('keeps every outline, burns outward and settles with colour only on the queen and the titles', () => {
    const g = hiveGeometry(200,60), facts = 'p:m · 中文👩‍💻 · 12 agents · worktree 开';
    const inChamber = (x: number, y: number) => x >= g.chamber.x && x < g.chamber.x + g.chamber.w && y >= g.chamber.y && y < g.chamber.y + g.chamber.h;
    let burning = 0;
    for (let time = 0; time <= IGNITION_MS; time += 20) {
      const frame = ignitionCells(g, time, facts);
      frame.chars.forEach((row, y) => {
        expect(displayWidth(row.join(''))).toBe(200);
        row.forEach((ch, x) => { if (g.grid[y]![x] !== ' ') expect(ch).toBe(g.grid[y]![x]); else if (!inChamber(x, y) && /[@#*+:]/.test(ch)) burning++; });
      });
    }
    expect(burning).toBeGreaterThan(0);
    const settled = ignitionCells(g, SETTLED_MS, facts), held = ignitionCells(g, IGNITION_MS, facts);
    expect(held.chars).toEqual(settled.chars);
    expect([...held.styles]).toEqual([...settled.styles]);
    const queen = new Set(g.cells[g.queen!]!.outline.map(([x, y]) => `${x},${y}`));
    held.chars.forEach((row, y) => row.forEach((ch, x) => {
      if (inChamber(x, y)) return;
      expect(ch).toBe(g.grid[y]![x]);
      if (ch.trim()) expect(held.styles[y * 200 + x]).toBe(queen.has(`${x},${y}`) ? 1 : 0);
    }));
    expect(held.chars.map(row => row.join('')).join('\n')).toContain(HIVE_SUBTITLE);
    expect(HIVE_SUBTITLE).toContain(`v${VERSION}`);
  });
  it('keeps the ignition clock across a resize and passes the first printable skip', async () => {
    vi.useFakeTimers();
    const done = vi.fn(), session = { log: { header: { cwd: process.cwd() } }, config: { swarm: { maxAgents: 12 } }, providerName: 'p', model: 'm' } as Session;
    const screen = render(<Ignition session={session} height={39} columns={118} onDone={done} onExit={() => {}} />);
    try {
      await vi.advanceTimersByTimeAsync(500);
      screen.rerender(<Ignition session={session} height={19} columns={58} onDone={done} onExit={() => {}} />);
      await vi.advanceTimersByTimeAsync(399); expect(done).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1); expect(done).toHaveBeenCalledOnce();
      expect(IGNITION_MS).toBe(900);
      // The resized geometry is painted in full; the settled frame is what the terminal shows.
      const shown = screenOf(screen.frames, 58, 19);
      expect(shown.join('\n')).toContain('H   I   V   E');
      expect(shown.join('\n')).not.toMatch(/[@#*+:]{3}/);
    } finally { screen.unmount(); vi.useRealTimers(); }
    const skip = render(<Ignition session={session} height={9} columns={38} onDone={done} onExit={() => {}} />);
    try { skip.stdin.write('z'); await new Promise(resolve => setTimeout(resolve,30)); expect(done).toHaveBeenLastCalledWith('z'); } finally { skip.unmount(); }
  });
  it('paints nothing through Ink and hands the screen over cleared inside one synchronized update', async () => {
    const session = { log: { header: { cwd: process.cwd() } }, config: { swarm: { maxAgents: 12 } }, providerName: 'p', model: 'm' } as Session;
    const handoff = render(<Ignition session={session} height={20} columns={60} onDone={() => {}} onExit={() => {}} />);
    await new Promise(resolve => setTimeout(resolve, 120));
    const painted = handoff.frames.length;
    expect(painted).toBeGreaterThan(1);
    handoff.rerender(<></>);
    await new Promise(resolve => setTimeout(resolve, 160));
    const after = handoff.frames.slice(painted).join('');
    expect(after).toContain('\x1b[?2026h\x1b[0m\x1b[2J\x1b[H');
    expect(after.endsWith('\x1b[?2026l')).toBe(true);
    expect(clearsAreSynchronized(handoff.frames)).toBe(true);
    expect(screenOf(handoff.frames, 60, 20).every(line => line === '')).toBe(true);
    handoff.unmount();
    let exited = 0;
    const quit = render(<Ignition session={session} height={20} columns={60} onDone={() => {}} onExit={() => { exited++; }} />);
    await new Promise(resolve => setTimeout(resolve, 40));
    quit.stdin.write('\x03');
    await new Promise(resolve => setTimeout(resolve, 30));
    const beforeExit = quit.frames.length;
    quit.unmount();
    await new Promise(resolve => setTimeout(resolve, 160));
    expect(exited).toBe(1);
    expect(quit.frames.slice(beforeExit).join('')).not.toContain('\x1b[2J');
  });
});
