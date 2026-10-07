import type { Theme } from '../theme.js';
import { truncateDisplay, displayWidth, graphemes } from '../../core/text-width.js';
import { terminalText } from '../../core/terminal-text.js';
import { VERSION } from '../../core/version.js';
import { cellHash, type hiveGeometry } from './honeycomb.js';
export interface Span { text: string; style: number }
/** One frame as cells: '' marks the trailing column of a wide character. */
export interface IgnitionCells { columns: number; rows: number; chars: string[][]; styles: Int16Array }
export const HIVE_TITLE = `ROAST HIVE v${VERSION}`;
export const HIVE_SUBTITLE = `H   I   V   E  v${VERSION}`;
/** Timeline (ms): the ring leaves the chamber at once, crosses the hive by 440, every cell has cooled by SETTLED_MS (780), then the frame holds. */
const WAVE_START = 0, WAVE_SPAN = 440, HEAT = 180, COOL = 160, QUEEN_AT = 600, TITLE_AT = 620, FACTS_AT = 740;
export const SETTLED_MS = WAVE_START + WAVE_SPAN + HEAT + COOL;
export function ignitionPalette(theme: Theme) {
  return [
    { color: theme.border, dim: true, bold: false },
    { color: theme.accent2, dim: false, bold: true },
    { color: theme.accent, dim: false, bold: false },
    { color: theme.gradient.at(-1), dim: false, bold: false },
    { color: theme.accent, dim: true, bold: false },
    { color: theme.muted, dim: false, bold: false },
    ...Array.from({ length: 8 }, (_, i) => ({ color: theme.gradient[Math.min(theme.gradient.length - 1, Math.floor(i * theme.gradient.length / 8))], dim: false, bold: true })),
  ];
}
const ringStyle = (d: number) => 6 + Math.min(7, Math.floor(d * 8));
export function ignitionCells(geometry: ReturnType<typeof hiveGeometry>, time: number, facts: string): IgnitionCells {
  const { columns, rows, tier, block, logo } = geometry;
  const chars = geometry.grid.map(line => [...line]), styles = new Int16Array(columns * rows);
  const put = (x: number, y: number, ch: string, style: number) => { if (x >= 0 && y >= 0 && x < columns && y < rows) { chars[y]![x] = ch; styles[y * columns + x] = style; } };
  // One style decision per cell per frame. The ring lights each outline while the
  // interior burns, cools through a dim accent and returns to the resting border:
  // the settled frame keeps no leftover colour except the queen cell.
  for (const cell of geometry.cells) {
    const d = geometry.distances[cell.id]!, elapsed = time - (WAVE_START + WAVE_SPAN * d);
    const outline = elapsed < 0 || elapsed >= HEAT + COOL ? 0 : elapsed < HEAT ? ringStyle(d) : 4;
    for (const [x, y, ch] of cell.outline) put(x, y, ch, outline);
    if (elapsed >= 0 && elapsed < HEAT) {
      const heat = Math.min(5, Math.floor(elapsed / (HEAT / 6))), ch = '@#*+:.'.charAt(heat), style = [1, 1, 2, 2, 3, 4][heat]!;
      for (const [x, y] of cell.interior) put(x, y, ch, style);
    } else if (elapsed >= HEAT && elapsed < HEAT + COOL / 2 && cell.interior.length && cellHash(cell.c, cell.q) % 100 < 18) {
      const [x, y] = cell.interior[cellHash(cell.q, cell.c) % cell.interior.length]!;
      put(x, y, '.', 4);
    }
  }
  // Neighbours share the queen's edges; light them last so the whole cell glows.
  const queen = geometry.queen === undefined ? undefined : geometry.cells[geometry.queen];
  if (queen && time >= QUEEN_AT) for (const [x, y, ch] of queen.outline) put(x, y, ch, 1);
  const text = (value: string, y: number, style: number, reveal = false, width = block.w) => {
    const line = truncateDisplay(terminalText(value), width), start = Math.floor((columns - displayWidth(line)) / 2);
    let x = start;
    for (const part of graphemes(line)) {
      const ch = part.text;
      const col = x - start, appeared = 300 + 400 * col / Math.max(1, width - 1);
      if (!reveal || time >= appeared) put(x, y, ch, reveal ? time - appeared < 60 ? 1 : 6 + Math.min(7, Math.floor(col * 8 / width)) : tier === 'line' ? Math.abs(col - time / 900 * width) < 2 ? 1 : 6 + Math.min(7, Math.floor(col * 8 / width)) : style);
      // Wide facts consume two columns; the empty trailing cell keeps the
      // physical width fixed when the row is painted.
      if (displayWidth(ch) === 2) put(x + 1, y, '', style);
      x += displayWidth(ch);
    }
  };
  if (tier === 'line' || tier === 'tiny') text(tier === 'tiny' ? 'ROAST' : HIVE_TITLE, Math.floor(rows / 2), 6 + Math.min(7, Math.floor(time / 120)), false, columns);
  else {
    logo.forEach((line, row) => text(line, block.y + row, 6, true));
    if (time >= TITLE_AT) {
      if (logo.length > 1) {
        text(HIVE_SUBTITLE, block.y + logo.length + 1, 1);
        const start = Math.floor((columns - HIVE_SUBTITLE.length) / 2);
        for (let x = start + 14; x < start + HIVE_SUBTITLE.length; x++) styles[(block.y + logo.length + 1) * columns + x] = 0;
      }
      text(facts, block.y + block.h - 1, time >= FACTS_AT ? 5 : 0);
    }
  }
  return { columns, rows, chars, styles };
}
/** Style runs per row; spaces carry no colour, so they join the preceding run. */
export function ignitionFrame(geometry: ReturnType<typeof hiveGeometry>, time: number, facts: string): Span[][] {
  const { columns, chars, styles } = ignitionCells(geometry, time, facts);
  return chars.map((row, y) => {
    const spans: Span[] = [];
    row.forEach((ch, x) => {
      const last = spans.at(-1), style = !ch.trim() ? last?.style ?? 0 : styles[y * columns + x]!;
      if (last?.style === style) last.text += ch; else spans.push({ text: ch, style });
    });
    return spans;
  });
}
