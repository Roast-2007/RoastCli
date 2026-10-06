import { useEffect } from 'react';
import { useStdout } from 'ink';
import { useTerminal } from './terminal.js';
export interface MouseEvent {
  kind: 'press' | 'release' | 'wheel'; button: 'left' | 'middle' | 'right' | 'none';
  x: number; y: number; shift: boolean; alt: boolean; ctrl: boolean; delta?: number;
}
/** SGR packets can be batched; Ink may strip the first ESC. Coordinates are zero based. */
export function parseMouse(input: string): MouseEvent[] {
  const events: MouseEvent[] = [];
  for (const match of input.matchAll(/(?:\x1b)?\[<(\d+);(\d+);(\d+)([Mm])/g)) {
    const code = Number(match[1]), x = Number(match[2]) - 1, y = Number(match[3]) - 1;
    if (!Number.isSafeInteger(code) || !Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0 || code > 127) continue;
    const wheel = (code & 64) !== 0;
    events.push({ kind: wheel ? 'wheel' : match[4] === 'm' || (code & 3) === 3 ? 'release' : 'press', button: wheel ? 'none' : (['left', 'middle', 'right', 'none'] as const)[code & 3]!, x, y, shift: Boolean(code & 4), alt: Boolean(code & 8), ctrl: Boolean(code & 16), ...(wheel ? { delta: match[4] === 'm' || (code & 3) > 1 ? 0 : code & 1 ? 3 : -3 } : {}) });
  }
  return events;
}
export function mouseWheel(input: string): number | null {
  const events = parseMouse(input);
  return events.length ? events.reduce((sum, event) => sum + (event.delta ?? 0), 0) : null;
}
export function isMouseInput(input: string) { return parseMouse(input).length > 0; }
export function createDoubleClick() {
  let previous: { target: string; at: number } | undefined;
  return (target: string, at = Date.now()) => {
    const double = Boolean(previous && previous.target === target && at >= previous.at && at - previous.at <= 400);
    previous = double ? undefined : { target, at };
    return double;
  };
}
export function useMouseReporting(enabled?: boolean) {
  const { stdout } = useStdout(), terminal = useTerminal();
  enabled ??= terminal.mouse !== false;
  useEffect(() => {
    if (!stdout.isTTY || !enabled) return;
    stdout.write('\x1b[?1000h\x1b[?1006h');
    return () => { stdout.write('\x1b[?1006l\x1b[?1000l'); };
  }, [stdout, enabled]);
}
