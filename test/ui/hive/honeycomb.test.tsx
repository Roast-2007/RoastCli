import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { displayWidth } from '../../../src/core/text-width.js';
import { generateHoneycomb, hiveGeometry, ignitionSize } from '../../../src/ui/hive/honeycomb.js';
import { BIG_ROAST_LOGO } from '../../../src/ui/hive/wordmark.js';
import { ignitionFrame, MAX_ROW_SPANS, MAX_IGNITION_ELEMENTS } from '../../../src/ui/hive/ignition-frame.js';
import { Ignition, IGNITION_MS } from '../../../src/ui/hive/Ignition.js';
import type { Session } from '../../../src/agent/session.js';
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
describe('full-window ASCII honeycomb', () => {
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
  it('fills the first frame, settles to fixed embers and bounds every frame element count', () => {
    const g = hiveGeometry(200,60), plain = (time: number) => ignitionFrame(g,time,'p:m · 中文 · 12 agents · worktree 开').map(spans => spans.map(span => span.text).join(''));
    expect(plain(0)).toEqual(g.grid);
    expect(plain(800)).toEqual(plain(900));
    expect(plain(900).join('')).toMatch(/[.'*]/);
    for (let time = 0; time <= 900; time += 20) {
      const frame = ignitionFrame(g,time,'p:m · 中文👩‍💻 · 12 agents');
      expect(frame.every(row => row.length <= MAX_ROW_SPANS)).toBe(true);
      expect(1 + frame.length + frame.reduce((n,row) => n + row.length,0)).toBeLessThanOrEqual(MAX_IGNITION_ELEMENTS);
      expect(frame.every(row => displayWidth(row.map(span => span.text).join('')) <= 200)).toBe(true);
    }
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
    } finally { screen.unmount(); vi.useRealTimers(); }
    const skip = render(<Ignition session={session} height={9} columns={38} onDone={done} onExit={() => {}} />);
    try { skip.stdin.write('z'); await new Promise(resolve => setTimeout(resolve,30)); expect(done).toHaveBeenLastCalledWith('z'); } finally { skip.unmount(); }
  });
});
