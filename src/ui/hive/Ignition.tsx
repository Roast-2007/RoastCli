import { useLayoutEffect, useMemo, useRef } from 'react';
import { useInput, useStdout } from 'ink';
import path from 'node:path';
import type { Session } from '../../agent/session.js';
import { useTheme } from '../theme.js';
import { gitBranch } from '../status-info.js';
import { hiveGeometry } from './honeycomb.js';
import { ignitionCells, ignitionPalette, type IgnitionCells } from './ignition-frame.js';
import { BSU, ESU, colorDepth, paintCells, sgrPalette } from './ignition-paint.js';
export { ROAST_LOGO } from './wordmark.js';
export { ignitionSize } from './honeycomb.js';
export const IGNITION_MS = 900;
/** One cell-diff write per tick, paced by wall time. 16ms is also one Windows timer tick (~64fps there). */
export const IGNITION_FRAME_MS = 16;
/** A resize repaint clears the screen after a debounce; repaint whole frames until it has settled. */
const RESIZE_SETTLE_MS = 300;
/** Closes the handoff update if no workspace frame follows (Ink normally closes it at once). */
const HANDOFF_ESU_MS = 120;
const HIDE_CURSOR = '\x1b[?25l';
export function Ignition({ session, height, columns, onDone, onExit }: { session: Session; height: number; columns: number; onDone(text?: string): void; onExit(): void }) {
  const theme = useTheme(), { stdout } = useStdout(), finished = useRef(false), exiting = useRef(false);
  const callback = useRef(onDone); callback.current = onDone;
  const done = (text?: string) => { if (!finished.current || text) { finished.current = true; callback.current(text); } };
  const branch = useMemo(() => gitBranch(session.log.header.cwd), [session]);
  const facts = `${session.providerName}:${session.model} · ${path.basename(session.log.header.cwd)}${branch ? ` ⎇ ${branch}` : ''} · ${session.config.swarm.maxAgents} agents · worktree ${session.config.swarm.worktrees === false ? '关' : '开'}`;
  const sgr = useMemo(() => sgrPalette(ignitionPalette(theme), colorDepth(stdout)), [theme, stdout]);
  // Size changes only swap geometry; the clock below keeps running.
  const scene = useRef({ geometry: hiveGeometry(columns, height), facts, sgr });
  scene.current = { geometry: hiveGeometry(columns, height), facts, sgr };
  useLayoutEffect(() => {
    const started = Date.now();
    let previous: IgnitionCells | undefined, fullUntil = 0;
    const paint = () => {
      // A slow terminal still owes the previous frame: skip this one, the next diff covers it.
      if ((stdout as { writableNeedDrain?: boolean }).writableNeedDrain) return;
      const { geometry, facts, sgr } = scene.current;
      const next = ignitionCells(geometry, Math.min(IGNITION_MS, Date.now() - started), facts);
      const bytes = paintCells(Date.now() < fullUntil ? undefined : previous, next, sgr);
      previous = next;
      if (bytes) stdout.write(BSU + HIDE_CURSOR + bytes + ESU);
    };
    const resized = () => { fullUntil = Date.now() + RESIZE_SETTLE_MS; };
    stdout.on('resize', resized);
    paint();
    const frames = setInterval(paint, IGNITION_FRAME_MS), timer = setTimeout(() => done(), IGNITION_MS);
    return () => {
      clearInterval(frames);
      clearTimeout(timer);
      stdout.off('resize', resized);
      if (exiting.current) return;
      // Layout cleanup runs before Ink renders the next tree in this commit. Ink has
      // written nothing while the splash was mounted, so its first workspace frame
      // is a full write from the cursor: start it from a cleared, homed screen inside
      // one synchronized update. No cell of the last splash frame can survive.
      stdout.write(`${BSU}\x1b[0m\x1b[2J\x1b[H`);
      setTimeout(() => stdout.write(ESU), HANDOFF_ESU_MS);
    };
  }, [stdout]);
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exiting.current = true;
      return onExit();
    }
    done(input && !key.ctrl && !key.meta && !key.return && !key.escape && !key.tab && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow ? input : undefined);
  });
  return null;
}
