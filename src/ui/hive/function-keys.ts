import { useEffect, useRef } from 'react';
import { useStdin } from 'ink';

/** Ink's Key type discards function-key names, so read their raw sequences. */
export function useDeckFunctionKeys(active: boolean, cycle: (reverse: boolean) => void, help?: () => void) {
  const { stdin } = useStdin(), callback = useRef(cycle); callback.current = cycle;
  const onHelp = useRef(help); onHelp.current = help;
  useEffect(() => {
    if (!active) return;
    const handler = (data: Buffer | string) => {
      if (/\x1b(?:OP|\[(?:11~|57364u))/.test(data.toString())) onHelp.current?.();
      for (const match of data.toString().matchAll(/\x1b\[(?:17(?:;(\d+))?~|57369(?:;(\d+))?u)/g)) callback.current(Boolean((Number(match[1] ?? match[2] ?? 1) - 1) & 1));
    };
    stdin.on('data', handler); return () => { stdin.off('data', handler); };
  }, [stdin, active]);
}
