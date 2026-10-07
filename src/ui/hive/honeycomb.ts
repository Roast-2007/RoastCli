import { VERSION } from '../../core/version.js';
import { ROAST_LOGO, BIG_ROAST_LOGO } from './wordmark.js';
export type HiveTier = 'XL' | 'L' | 'M' | 'S' | 'line' | 'tiny';
export const CELL_SIZE = { XL: { s: 3, L: 8 }, L: { s: 2, L: 6 }, M: { s: 1, L: 4 }, S: { s: 1, L: 2 } } as const;
export interface Rect { x: number; y: number; w: number; h: number }
export interface Cell {
  id: number; c: number; q: number; cx: number; cy: number;
  outline: [number, number, string][]; interior: [number, number][];
}
export interface Honeycomb { grid: string[]; cellAt: Int32Array; cells: Cell[] }
export function ignitionSize(columns: number, rows: number): HiveTier {
  if (columns >= 150 && rows >= 44) return 'XL';
  if (columns >= 100 && rows >= 30) return 'L';
  if (columns >= 64 && rows >= 18) return 'M';
  if (columns >= 40 && rows >= 10) return 'S';
  return columns >= 24 && rows >= 3 ? 'line' : 'tiny';
}
export function chamberLayout(columns: number, rows: number, tier: HiveTier) {
  const big = tier === 'L' || tier === 'XL';
  let logo = big ? BIG_ROAST_LOGO : ROAST_LOGO;
  if (rows < logo.length + 6 || columns < Math.max(...logo.map(line => line.length)) + 6) logo = [`ROAST HIVE v${VERSION}`];
  const width = Math.max(...logo.map(line => line.length));
  const height = logo.length + (logo.length > 1 ? 4 : 2);
  const block = { x: Math.floor((columns - width) / 2), y: Math.floor((rows - height) / 2), w: width, h: height };
  const chamber = { x: block.x - 3, y: block.y - 1, w: width + 6, h: height + 2 };
  return { logo, block, chamber };
}
/** Flat-top ASCII hexagons; border coordinates match the hand-drawn samples. */
export function generateHoneycomb(columns: number, rows: number, tier: keyof typeof CELL_SIZE, options: { dx?: number; dy?: number; positiveOnly?: boolean; checkConflicts?: boolean; chamber?: Rect } = {}): Honeycomb {
  const { s, L } = CELL_SIZE[tier], width = L + 2 * s;
  const dx = options.dx ?? Math.floor((columns - width) / 2), dy = options.dy ?? Math.floor(rows / 2) - s;
  const grid = Array.from({ length: rows }, () => Array<string>(columns).fill(' '));
  const cellAt = new Int32Array(columns * rows).fill(-1), cells: Cell[] = [];
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < columns && y < rows;
  const intersects = (x: number, y: number) => options.chamber && x >= options.chamber.x && x < options.chamber.x + options.chamber.w && y >= options.chamber.y && y < options.chamber.y + options.chamber.h;
  const cMin = options.positiveOnly ? 0 : Math.floor((-dx - width) / (L + s)) - 1;
  const qMin = options.positiveOnly ? 0 : Math.floor((-dy - 3 * s) / (2 * s)) - 1;
  for (let c = cMin; c <= Math.ceil((columns - dx) / (L + s)) + 1; c++) {
    for (let q = qMin; q <= Math.ceil((rows - dy) / (2 * s)) + 1; q++) {
      const x0 = c * (L + s) + dx, y0 = q * 2 * s + (Math.abs(c % 2) ? s : 0) + dy;
      const outline: Cell['outline'] = [], interior: Cell['interior'] = [];
      for (let x = x0 + s; x < x0 + s + L; x++) outline.push([x, y0, '_']);
      for (let k = 1; k <= s; k++) {
        const left = x0 + s - k, right = x0 + s + L - 1 + k;
        outline.push([left, y0 + k, '/'], [right, y0 + k, '\\']);
        for (let x = left + 1; x < right; x++) interior.push([x, y0 + k]);
      }
      for (let j = 1; j <= s; j++) {
        const left = x0 + j - 1, right = x0 + L + 2 * s - j;
        outline.push([left, y0 + s + j, '\\'], [right, y0 + s + j, '/']);
        if (j === s) for (let x = x0 + s; x < x0 + s + L; x++) outline.push([x, y0 + 2 * s, '_']);
        else for (let x = left + 1; x < right; x++) interior.push([x, y0 + s + j]);
      }
      if (![...outline, ...interior].some(([x, y]) => inside(x, y)) || [...outline, ...interior].some(([x, y]) => intersects(x, y))) continue;
      const cell: Cell = { id: cells.length, c, q, cx: x0 + (width - 1) / 2, cy: y0 + s, outline, interior };
      cells.push(cell);
      for (const [x, y] of interior) if (inside(x, y)) cellAt[y * columns + x] = cell.id;
      for (const [x, y, ch] of outline) {
        if (!inside(x, y)) continue;
        if (options.checkConflicts && grid[y]![x] !== ' ' && grid[y]![x] !== ch) throw new Error(`Honeycomb conflict at ${x},${y}`);
        grid[y]![x] = ch; cellAt[y * columns + x] = cell.id;
      }
    }
  }
  return { grid: grid.map(row => row.join('')), cellAt, cells };
}
export function cellHash(c: number, q: number) { return ((Math.imul(c + 71, 73856093) ^ Math.imul(q + 37, 19349663)) >>> 0); }
const cache = new Map<string, ReturnType<typeof buildGeometry>>();
function buildGeometry(columns: number, rows: number, tier: HiveTier) {
  const layout = chamberLayout(columns, rows, tier);
  const geometry = tier === 'line' || tier === 'tiny' ? { grid: Array<string>(rows).fill(' '.repeat(columns)), cellAt: new Int32Array(columns * rows).fill(-1), cells: [] } : generateHoneycomb(columns, rows, tier, { chamber: layout.chamber });
  const candidates = geometry.cells.filter(cell => cell.outline.every(([x, y]) => x >= 0 && x < columns && y >= 0 && y < layout.chamber.y));
  candidates.sort((a, b) => (layout.chamber.y - a.cy) ** 2 + (columns / 2 - a.cx) ** 2 - ((layout.chamber.y - b.cy) ** 2 + (columns / 2 - b.cx) ** 2));
  const distances = geometry.cells.map(cell => Math.hypot(Math.max(0, Math.abs(cell.cx - columns / 2) - layout.chamber.w / 2), Math.max(0, Math.abs(cell.cy - rows / 2) - layout.chamber.h / 2)));
  const max = Math.max(1, ...distances);
  return { ...geometry, ...layout, queen: candidates[0]?.id, distances: distances.map(distance => distance / max), tier, columns, rows };
}
export function hiveGeometry(columns: number, rows: number, tier = ignitionSize(columns, rows)) {
  const key = `${columns}:${rows}:${tier}`;
  if (!cache.has(key)) { if (cache.size >= 8) cache.delete(cache.keys().next().value!); cache.set(key, buildGeometry(columns, rows, tier)); }
  return cache.get(key)!;
}
