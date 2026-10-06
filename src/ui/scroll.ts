import { useTerminal } from './terminal.js';
import { useLayoutEffect, useRef, useState } from 'react';
import type { Key } from 'ink';
import { mouseWheel } from './mouse.js';

/** A continuous line viewport; the ref also accumulates input between paints. */
export function useScroll(total: number, count: number) {
  const { mouse } = useTerminal();
  const [offset, setOffset] = useState(0);
  const current = useRef(offset);
  const max = Math.max(0, total - count);
  const start = Math.max(0, Math.min(offset, max));
  useLayoutEffect(() => { current.current = start; if (offset !== start) setOffset(start); }, [start, offset]);
  const move = (value: number) => { current.current = Math.max(0, Math.min(value, max)); setOffset(current.current); };
  const onKey = (input: string, key: Key) => {
    const wheel = mouseWheel(input);
    if (wheel !== null) { if (mouse !== false) move(current.current + wheel); return true; }
    if (key.home || input === 'g') { move(0); return true; }
    if (key.end || input === 'G') { move(max); return true; }
    if (key.upArrow || key.pageUp || input === 'k') { move(current.current - (key.pageUp ? Math.max(1, count - 1) : 1)); return true; }
    if (key.downArrow || key.pageDown || input === 'j') { move(current.current + (key.pageDown ? Math.max(1, count - 1) : 1)); return true; }
    return false;
  };
  return { start, max, move, onKey, position: () => current.current };
}

export function panelLayout(height: number, width: number, extraHeader = 0) {
  height = Math.max(1, height);
  const border = height >= 6 && width >= 8;
  const inner = height - (border ? 2 : 0);
  const header = inner >= 3 ? 1 : 0, footer = inner >= 2 ? 1 : 0;
  const extra = Math.min(extraHeader, Math.max(0, inner - header - footer - 1));
  return { border, header, footer, extra, count: Math.max(1, inner - header - footer - extra), width: Math.max(1, width - (border ? 4 : 0)) };
}
