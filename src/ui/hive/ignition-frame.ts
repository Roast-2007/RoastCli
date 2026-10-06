import type { Theme } from '../theme.js';
import { truncateDisplay, displayWidth, graphemes } from '../../core/text-width.js';
import { terminalText } from '../../core/terminal-text.js';
import { cellHash, type hiveGeometry } from './honeycomb.js';
export interface Span { text: string; style: number }
export const MAX_ROW_SPANS = 48;
export const MAX_IGNITION_ELEMENTS = 1 + 60 * (1 + MAX_ROW_SPANS);
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
export function ignitionFrame(geometry: ReturnType<typeof hiveGeometry>, time: number, facts: string): Span[][] {
  const { columns, rows, tier, block, logo } = geometry;
  const grid = geometry.grid.map(line => [...line]), styles = new Int16Array(columns * rows);
  const put = (x: number, y: number, ch: string, style: number) => { if (x >= 0 && y >= 0 && x < columns && y < rows) { grid[y]![x] = ch; styles[y * columns + x] = style; } };
  // Exactly one style calculation per cell per frame. Geometry and ownership
  // are cached; React receives spans, never an element per character.
  for (const cell of geometry.cells) {
    const d = geometry.distances[cell.id]!, elapsed = time - (60 + 400 * d);
    const outline = cell.id === geometry.queen && time >= 620 ? 1 : elapsed < 0 ? 0 : d > 0.72 && elapsed >= 200 ? 0 : 6 + Math.min(7, Math.floor(d * 8));
    for (const [x, y, ch] of cell.outline) put(x, y, ch, outline);
    if (elapsed >= 0 && elapsed < 200) {
      const heat = Math.min(5, Math.floor(elapsed / (200 / 6))), ch = '@#*+:.'.charAt(heat), style = [1, 1, 2, 2, 3, 0][heat]!;
      for (const [x, y] of cell.interior) put(x, y, ch, style);
    } else if (elapsed >= 200 && cellHash(cell.c, cell.q) % 100 < 18) {
      const [x, y] = cell.interior[cellHash(cell.q, cell.c) % cell.interior.length]!;
      put(x, y, cellHash(cell.c, cell.q) % 10 < 7 ? '.' : cellHash(cell.c, cell.q) % 10 < 9 ? "'" : '*', 4);
    }
  }
  const text = (value: string, y: number, style: number, reveal = false, width = block.w) => {
    const line = truncateDisplay(terminalText(value), width), start = Math.floor((columns - displayWidth(line)) / 2);
    let x = start;
    for (const part of graphemes(line)) {
      const ch = part.text;
      const col = x - start, appeared = 300 + 400 * col / Math.max(1, width - 1);
      if (!reveal || time >= appeared) put(x, y, ch, reveal ? time - appeared < 60 ? 1 : 6 + Math.min(7, Math.floor(col * 8 / width)) : tier === 'line' ? Math.abs(col - time / 900 * width) < 2 ? 1 : 6 + Math.min(7, Math.floor(col * 8 / width)) : style);
      // Wide facts consume two columns; the empty trailing entry keeps the
      // physical width fixed when characters are joined into spans.
      if (displayWidth(ch) === 2) put(x + 1, y, '', style);
      x += displayWidth(ch);
    }
  };
  if (tier === 'line' || tier === 'tiny') text(tier === 'tiny' ? 'ROAST' : 'ROAST HIVE v0.5.0', Math.floor(rows / 2), 6 + Math.min(7, Math.floor(time / 120)), false, columns);
  else {
    logo.forEach((line, row) => text(line, block.y + row, 6, true));
    if (time >= 620) {
      if (logo.length > 1) {
        const subtitle = 'H   I   V   E  v0.5.0';
        text(subtitle, block.y + logo.length + 1, 1);
        const start = Math.floor((columns - subtitle.length) / 2);
        for (let x = start + 14; x < start + subtitle.length; x++) styles[(block.y + logo.length + 1) * columns + x] = 0;
      }
      text(facts, block.y + block.h - 1, time >= 740 ? 5 : 0);
    }
  }
  return grid.map((row, y) => {
    const spans: Span[] = [];
    // Unpainted spaces inherit the preceding style (no background colors).
    // This merges equivalent whitespace without changing any visible style.
    row.forEach((ch, x) => {
      const last = spans.at(-1), style = !ch.trim() ? last?.style ?? 0 : styles[y * columns + x]!;
      if (last?.style === style) last.text += ch; else spans.push({ text: ch, style });
    });
    return spans;
  });
}
