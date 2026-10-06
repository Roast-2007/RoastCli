import { createContext, useContext } from 'react';
import type { RoastConfig } from '../core/config.js';

export interface TerminalPreferences { motion: boolean; ascii: boolean; gutter?: number; mouse?: boolean; hints?: 'full' | 'compact' | 'off' }
export function terminalPreferences(env: NodeJS.ProcessEnv = process.env, ui?: RoastConfig['ui']): TerminalPreferences {
  const dumb = env['TERM'] === 'dumb';
  return { hints: ui?.hints ?? 'full', mouse: ui?.mouse ?? true, gutter: ui?.gutter ?? 2, motion: !dumb && env['ROAST_REDUCED_MOTION'] !== '1' && ui?.motion !== 'reduced', ascii: dumb || env['ROAST_ASCII'] === '1' || ui?.ascii === true };
}
export const TerminalContext = createContext<TerminalPreferences>(terminalPreferences());
export const useTerminal = () => useContext(TerminalContext);
const unicodeGlyphs = { pointer: '›', ok: '✓', error: '✗', warning: '⚠', cancelled: '⊘', info: 'ℹ', thinking: '💭', branch: '⎇', separator: '│', up: '↑', down: '↓' };
const asciiGlyphs: typeof unicodeGlyphs = { pointer: '>', ok: '+', error: 'x', warning: '!', cancelled: '-', info: 'i', thinking: '...', branch: '@', separator: '|', up: '^', down: 'v' };
export const useGlyphs = () => useTerminal().ascii ? asciiGlyphs : unicodeGlyphs;
