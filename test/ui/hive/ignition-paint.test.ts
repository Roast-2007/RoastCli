import { describe, expect, it } from 'vitest';
import { hiveGeometry } from '../../../src/ui/hive/honeycomb.js';
import { ignitionCells, ignitionPalette, type IgnitionCells } from '../../../src/ui/hive/ignition-frame.js';
import { colorDepth, paintCells, sgrPalette } from '../../../src/ui/hive/ignition-paint.js';
import { AURORA, MONO } from '../../../src/ui/theme.js';
import { screenOf, VtScreen } from './vt.js';

const plain = (cells: IgnitionCells) => cells.chars.map((row) => row.join('').trimEnd());
const row = (chars: string[]): IgnitionCells => ({ columns: chars.length, rows: 1, chars: [chars], styles: new Int16Array(chars.length) });

describe('ignition painter', () => {
  it('reproduces every frame from cell diffs, at any frame rate', () => {
    const sgr = sgrPalette(ignitionPalette(AURORA), 24);
    for (const [columns, rows] of [
      [120, 36],
      [70, 20],
      [44, 11],
    ] as const) {
      const g = hiveGeometry(columns, rows),
        facts = 'p:m · 中文 · 12 agents · worktree 开';
      for (const step of [16, 47]) {
        const screen = new VtScreen(columns, rows + 1);
        let previous: IgnitionCells | undefined;
        for (let time = 0; time <= 900; time += step) {
          const next = ignitionCells(g, time, facts);
          screen.write(paintCells(previous, next, sgr));
          previous = next;
          expect(screen.lines().slice(0, rows)).toEqual(plain(next));
        }
      }
    }
  });
  it('sends only changed cells and nothing for an unchanged frame', () => {
    const g = hiveGeometry(140, 40),
      sgr = sgrPalette(ignitionPalette(AURORA), 24);
    const settled = ignitionCells(g, 900, 'facts');
    expect(paintCells(settled, ignitionCells(g, 900, 'facts'), sgr)).toBe('');
    const full = paintCells(undefined, ignitionCells(g, 300, 'facts'), sgr);
    const diff = paintCells(ignitionCells(g, 284, 'facts'), ignitionCells(g, 300, 'facts'), sgr);
    expect(full.startsWith('\x1b[0m\x1b[H\x1b[2J')).toBe(true);
    expect(diff).not.toContain('\x1b[2J');
    expect(diff.length).toBeLessThan(full.length / 2);
  });
  it('never splits wide characters when narrow text replaces them or the reverse', () => {
    const sgr = sgrPalette(ignitionPalette(MONO), 1);
    const a = row(['a', 'b', '中', '', '文', '', 'c', 'd']),
      b = row(['a', 'b', '中', '', 'x', 'y', 'z', 'd']);
    const writes = [paintCells(undefined, a, sgr), paintCells(a, b, sgr)];
    expect(screenOf(writes, 8, 2)[0]).toBe('ab中xyzd');
    writes.push(paintCells(b, a, sgr));
    expect(screenOf(writes, 8, 2)[0]).toBe('ab中文cd');
  });
  it('encodes colour for each terminal depth like chalk, and none without colour', () => {
    const palette = [
      { color: '#22d3ee', dim: false, bold: true },
      { color: undefined, dim: true, bold: false },
    ];
    expect(sgrPalette(palette, 24)).toEqual(['\x1b[0;1;38;2;34;211;238m', '\x1b[0;2m']);
    expect(sgrPalette(palette, 8)[0]).toBe('\x1b[0;1;38;5;81m');
    expect(sgrPalette(palette, 4)[0]).toMatch(/^\x1b\[0;1;(3[0-7]|9[0-7])m$/);
    expect(sgrPalette(palette, 1)[0]).toBe('\x1b[0;1m');
    expect(colorDepth({ getColorDepth: () => 8 }, {})).toBe(8);
    expect(colorDepth({}, {})).toBe(24);
    expect(colorDepth({ getColorDepth: () => 24 }, { NO_COLOR: '1' })).toBe(1);
    expect(colorDepth({ getColorDepth: () => 24 }, { FORCE_COLOR: '0' })).toBe(1);
    expect(colorDepth({ getColorDepth: () => 24 }, { TERM: 'dumb' })).toBe(1);
    expect(
      colorDepth(
        {
          getColorDepth: () => {
            throw new Error('pipe');
          },
        },
        {},
      ),
    ).toBe(24);
  });
});
