/**
 * 主题：语义色 token。默认 Aurora（极光青 + 紫渐变）；NO_COLOR 时用 mono（只用粗细/反显/暗显）。
 * Ink 的 color 接受十六进制，chalk 会按终端能力自动降级到 256 / 16 色。
 */
import { createContext, useContext } from 'react';

export interface Theme {
  name: string;
  accent?: string;
  accent2?: string;
  muted?: string;
  success?: string;
  warn?: string;
  danger?: string;
  info?: string;
  user?: string;
  tool?: string;
  border?: string;
  /** 标题/横幅渐变色（2~3 个停靠点） */
  gradient: string[];
}

export const EMBER: Theme = {
  name: 'ember',
  accent: '#ff7a18',
  accent2: '#ffb347',
  muted: '#8a8178',
  success: '#7ddc8a',
  warn: '#ffcc4d',
  danger: '#ff6b5b',
  info: '#6cb6ff',
  user: '#ffa45c',
  tool: '#ffd27a',
  border: '#5a4a3f',
  gradient: ['#ff4e1a', '#ff7a18', '#ffb347'],
};

/** 冷色系：极光青 + 紫 */
export const AURORA: Theme = {
  name: 'aurora',
  accent: '#3ddbd9',
  accent2: '#a78bfa',
  muted: '#7a8699',
  success: '#6ee7a8',
  warn: '#f5c76b',
  danger: '#ff6b8b',
  info: '#7cc4ff',
  user: '#8be9fd',
  tool: '#c4b5fd',
  border: '#3b4a5c',
  gradient: ['#22d3ee', '#3ddbd9', '#a78bfa'],
};

/** 浅色终端：更深的前景色，保证白底上的对比度 */
export const DAYLIGHT: Theme = {
  name: 'daylight',
  accent: '#c2410c',
  accent2: '#b45309',
  muted: '#6b7280',
  success: '#15803d',
  warn: '#a16207',
  danger: '#b91c1c',
  info: '#1d4ed8',
  user: '#9a3412',
  tool: '#7c2d12',
  border: '#9ca3af',
  gradient: ['#b91c1c', '#c2410c', '#b45309'],
};

export const MONO: Theme = { name: 'mono', gradient: [] };

export const THEMES: Readonly<Record<string, Theme>> = { ember: EMBER, aurora: AURORA, daylight: DAYLIGHT, mono: MONO };

export const DEFAULT_THEME = AURORA;

/** 优先级：NO_COLOR → ROAST_THEME 环境变量 → 配置 ui.theme → aurora；未知名称回退 aurora */
export function pickTheme(env: NodeJS.ProcessEnv = process.env, configured?: string): Theme {
  if ((env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') || env['FORCE_COLOR'] === '0' || env['TERM'] === 'dumb') return MONO;
  const name = env['ROAST_THEME'] || configured || DEFAULT_THEME.name;
  return THEMES[name] ?? DEFAULT_THEME;
}

export const ThemeContext = createContext<Theme>(DEFAULT_THEME);
export const useTheme = (): Theme => useContext(ThemeContext);

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')}`;
}

/** 文本按字符做线性渐变；无渐变色时返回 undefined 颜色 */
export function gradientChars(text: string, stops: string[]): { ch: string; color: string | undefined }[] {
  const chars = [...text];
  if (stops.length < 2) return chars.map((ch) => ({ ch, color: stops[0] }));
  const rgb = stops.map(hexToRgb);
  return chars.map((ch, i) => {
    const t = chars.length <= 1 ? 0 : i / (chars.length - 1);
    const seg = Math.min(rgb.length - 2, Math.floor(t * (rgb.length - 1)));
    const local = t * (rgb.length - 1) - seg;
    const a = rgb[seg]!;
    const b = rgb[seg + 1]!;
    return { ch, color: rgbToHex([a[0] + (b[0] - a[0]) * local, a[1] + (b[1] - a[1]) * local, a[2] + (b[2] - a[2]) * local]) };
  });
}

export { displayWidth } from '../core/text-width.js';
