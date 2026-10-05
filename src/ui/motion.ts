import { useEffect, useState } from 'react';
import { useTerminal } from './terminal.js';

/** Short color transitions never change geometry or delay keyboard input. */
export function useEntrance(identity: unknown, duration = 224): number {
  const { motion } = useTerminal();
  const [frame, setFrame] = useState({ identity, progress: motion ? 0 : 1 });
  useEffect(() => {
    if (!motion) { setFrame({ identity, progress: 1 }); return; }
    const started = Date.now();
    setFrame({ identity, progress: 0 });
    const timer = setInterval(() => {
      const progress = Math.min(1, (Date.now() - started) / duration);
      setFrame({ identity, progress });
      if (progress === 1) clearInterval(timer);
    }, 32);
    return () => clearInterval(timer);
  }, [identity, motion, duration]);
  return !motion ? 1 : frame.identity === identity ? frame.progress : 0;
}

export function motionColor(from: string | undefined, to: string | undefined, progress: number): string | undefined {
  if (!from || !to || !/^#[\da-f]{6}$/i.test(from) || !/^#[\da-f]{6}$/i.test(to)) return to;
  const p = 1 - (1 - Math.max(0, Math.min(1, progress))) ** 3;
  const channels = [1, 3, 5].map((offset) => {
    const a = parseInt(from.slice(offset, offset + 2), 16), b = parseInt(to.slice(offset, offset + 2), 16);
    return Math.round(a + (b - a) * p).toString(16).padStart(2, '0');
  });
  return `#${channels.join('')}`;
}
