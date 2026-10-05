import { useEffect } from 'react';
import { useStdout } from 'ink';

/** Ink removes the leading ESC before passing unknown CSI sequences to useInput. */
export function mouseWheel(input: string): number | null {
  const match = /^(?:\u001b)?\[<(\d+);\d+;\d+([Mm])$/.exec(input);
  if (!match) return null;
  const code = Number(match[1]);
  if (match[2] === 'm' || (code & 64) === 0 || (code & 3) > 1) return 0;
  return (code & 1) === 0 ? -3 : 3;
}
export function isMouseInput(input: string): boolean {
  return /^(?:\u001b)?\[<\d+;\d+;\d+[Mm]$/.test(input);
}
export function useMouseReporting() {
  const { stdout } = useStdout();
  useEffect(() => {
    if (!stdout.isTTY) return;
    stdout.write('\u001b[?1000h\u001b[?1006h');
    return () => {
      stdout.write('\u001b[?1006l\u001b[?1000l');
    };
  }, [stdout]);
}
