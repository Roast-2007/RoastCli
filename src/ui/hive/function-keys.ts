import { useEffect, useRef } from 'react';
import { useStdin } from 'ink';

/** Ink's Key type discards function-key names, so read their raw sequences. */
export function useDeckFunctionKeys(active: boolean, cycle: (reverse: boolean) => void) {
  const { stdin } = useStdin(), callback = useRef(cycle); callback.current = cycle;
  useEffect(() => {
    if (!active) return;
    const handler = (data: Buffer | string) => {
      for (const match of data.toString().matchAll(/\x1b\[(?:17(?:;(\d+))?~|57369(?:;(\d+))?u)/g)) callback.current(Boolean((Number(match[1] ?? match[2] ?? 1) - 1) & 1));
    };
    stdin.on('data', handler); return () => { stdin.off('data', handler); };
  }, [stdin, active]);
}
