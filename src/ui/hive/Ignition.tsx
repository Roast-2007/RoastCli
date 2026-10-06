import { useEffect, useMemo, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import path from 'node:path';
import type { Session } from '../../agent/session.js';
import { useTheme } from '../theme.js';
import { useEntrance } from '../motion.js';
import { gitBranch } from '../status-info.js';
import { hiveGeometry } from './honeycomb.js';
import { ignitionFrame, ignitionPalette } from './ignition-frame.js';
export { ROAST_LOGO } from './wordmark.js';
export { ignitionSize } from './honeycomb.js';
export const IGNITION_MS = 900;
export function Ignition({ session, height, columns, onDone, onExit }: { session: Session; height: number; columns: number; onDone(text?: string): void; onExit(): void }) {
  const theme = useTheme(), progress = useEntrance('ignition', IGNITION_MS), finished = useRef(false);
  const callback = useRef(onDone); callback.current = onDone;
  const done = (text?: string) => { if (!finished.current || text) { finished.current = true; callback.current(text); } };
  useEffect(() => { const timer = setTimeout(() => done(), IGNITION_MS); return () => clearTimeout(timer); }, []);
  useInput((input, key) => { if (key.ctrl && input === 'c') return onExit(); done(input && !key.ctrl && !key.meta && !key.return && !key.escape && !key.tab && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow ? input : undefined); });
  const branch = useMemo(() => gitBranch(session.log.header.cwd), [session]);
  const facts = `${session.providerName}:${session.model} · ${path.basename(session.log.header.cwd)}${branch ? ` ⎇ ${branch}` : ''} · ${session.config.swarm.maxAgents} agents · worktree ${session.config.swarm.worktrees === false ? '关' : '开'}`;
  const geometry = hiveGeometry(columns, height), palette = ignitionPalette(theme);
  const frame = ignitionFrame(geometry, progress * IGNITION_MS, facts);
  return <Box height={height} width={columns} flexDirection="column" overflow="hidden">{frame.map((spans, row) => <Text key={row} wrap="truncate-end">{spans.map((span, index) => {
    const style = palette[span.style]!;
    return <Text key={index} color={style.color} bold={style.bold} dimColor={style.dim}>{span.text}</Text>;
  })}</Text>)}</Box>;
}
