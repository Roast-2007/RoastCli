/**
 * The ignition paints the terminal directly instead of through React: a frame is a
 * cell diff of a few kilobytes, so the 900ms animation keeps a steady 30fps on large
 * windows. Ink renders nothing while the splash is mounted; the handoff clears the
 * screen inside the same synchronized update as Ink's first workspace frame.
 */
import type { IgnitionCells } from './ignition-frame.js';
export const BSU = '\x1b[?2026h',
  ESU = '\x1b[?2026l';
/** Unchanged gaps up to this width are repainted instead of paying for a cursor move. */
const MERGE_GAP = 4;
interface PaletteEntry {
  color: string | undefined;
  dim: boolean;
  bold: boolean;
}

/** Mirrors Ink/chalk colour support: NO_COLOR and dumb terminals get no colour codes. */
export function colorDepth(stream: { getColorDepth?: (env?: NodeJS.ProcessEnv) => number }, env: NodeJS.ProcessEnv = process.env): number {
  if ((env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') || env['FORCE_COLOR'] === '0' || env['TERM'] === 'dumb') return 1;
  try {
    const depth = stream.getColorDepth?.(env);
    if (depth) return depth;
  } catch {
    // Test doubles and pipes may not implement colour detection.
  }
  return 24;
}

function rgbToAnsi256(r: number, g: number, b: number): number {
  if (r === g && g === b) return r < 8 ? 16 : r > 248 ? 231 : Math.round(((r - 8) / 247) * 24) + 232;
  return 16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5);
}

function ansi256ToAnsi16(code: number): number {
  if (code < 8) return 30 + code;
  if (code < 16) return 90 + code - 8;
  let r: number, g: number, b: number;
  if (code >= 232) r = g = b = ((code - 232) * 10 + 8) / 255;
  else {
    const c = code - 16,
      rest = c % 36;
    r = Math.floor(c / 36) / 5;
    g = Math.floor(rest / 6) / 5;
    b = (rest % 6) / 5;
  }
  const value = Math.max(r, g, b) * 2;
  if (value === 0) return 30;
  const base = 30 + ((Math.round(b) << 2) | (Math.round(g) << 1) | Math.round(r));
  return value === 2 ? base + 60 : base;
}

function foreground(hex: string | undefined, depth: number): string {
  if (!hex || depth < 4 || !/^#[\da-f]{6}$/i.test(hex)) return '';
  const n = Number.parseInt(hex.slice(1), 16),
    r = (n >> 16) & 255,
    g = (n >> 8) & 255,
    b = n & 255;
  if (depth >= 24) return `;38;2;${r};${g};${b}`;
  const code = rgbToAnsi256(r, g, b);
  return depth >= 8 ? `;38;5;${code}` : `;${ansi256ToAnsi16(code)}`;
}

/** Absolute SGR per palette style: every switch starts from a reset, so runs never inherit. */
export function sgrPalette(palette: readonly PaletteEntry[], depth: number): string[] {
  return palette.map((p) => `\x1b[0${p.bold ? ';1' : ''}${p.dim ? ';2' : ''}${foreground(p.color, depth)}m`);
}

function sameCell(prev: IgnitionCells, next: IgnitionCells, y: number, x: number): boolean {
  const ch = next.chars[y]![x]!;
  if (prev.chars[y]![x] !== ch) return false;
  // Spaces have no visible style (no background colours are used).
  return ch === ' ' || prev.styles[y * next.columns + x] === next.styles[y * next.columns + x];
}

function run(cells: IgnitionCells, y: number, from: number, to: number, sgr: readonly string[]): string {
  const row = cells.chars[y]!;
  let out = '',
    current = -1;
  for (let x = from; x < to; x++) {
    const ch = row[x]!;
    if (ch === '') continue;
    const style = cells.styles[y * cells.columns + x]!;
    if (style !== current && (ch !== ' ' || current === -1)) {
      out += sgr[style] ?? sgr[0] ?? '';
      current = style;
    }
    out += ch;
  }
  return out;
}

/**
 * Bytes that turn the screen showing `prev` into `next`. Without a comparable
 * previous frame the screen is cleared and every row repainted; callers wrap the
 * result in one synchronized update, so the clear is never shown on its own.
 */
export function paintCells(prev: IgnitionCells | undefined, next: IgnitionCells, sgr: readonly string[]): string {
  const full = !prev || prev.columns !== next.columns || prev.rows !== next.rows;
  let out = full ? '\x1b[0m\x1b[H\x1b[2J' : '';
  for (let y = 0; y < next.rows; y++) {
    if (full) {
      out += `\x1b[${y + 1};1H${run(next, y, 0, next.columns, sgr)}`;
      continue;
    }
    const row = next.chars[y]!,
      before = prev.chars[y]!;
    for (let x = 0; x < next.columns; ) {
      if (sameCell(prev, next, y, x)) {
        x++;
        continue;
      }
      let start = x,
        end = x + 1;
      for (let k = end, gap = 0; k < next.columns && gap <= MERGE_GAP; k++) {
        if (sameCell(prev, next, y, k)) gap++;
        else {
          gap = 0;
          end = k + 1;
        }
      }
      // Never split a wide character: include its lead or trailing column.
      while (start > 0 && (row[start] === '' || before[start] === '')) start--;
      while (end < next.columns && (row[end] === '' || before[end] === '')) end++;
      out += `\x1b[${y + 1};${start + 1}H${run(next, y, start, end, sgr)}`;
      x = end;
    }
  }
  return out ? `${out}\x1b[0m` : '';
}
