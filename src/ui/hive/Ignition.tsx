import { useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import path from 'node:path';
import type { Session } from '../../agent/session.js';
import { VERSION } from '../../core/version.js';
import { truncateDisplay } from '../../core/text-width.js';
import { terminalText } from '../../core/terminal-text.js';
import { gradientChars, useTheme } from '../theme.js';
import { motionColor, useEntrance } from '../motion.js';
import { gitBranch } from '../status-info.js';
export const HONEYCOMB = [' __    __    __     ', '/  \\__/  \\__/  \\__ ', '\\__/  \\__/  \\__/  \\', '/  \\__/  \\__/  \\__/', '\\__/  \\__/  \\__/  \\', '   \\__/  \\__/  \\__/'];
export const ROAST_LOGO = [' ____   ___    _    ____ _____', '|  _ \\ / _ \\  / \\  / ___|_   _|', '| |_) | | | |/ _ \\ \\___ \\ | |', '|  _ <| |_| / ___ \\ ___) || |', '|_| \\_\\\\___/_/   \\_\\____/ |_|'];
export const IGNITION_MS = 640;
export function ignitionSize(columns: number, rows: number): 'full' | 'line' | 'small' { return columns >= 60 && rows >= 12 ? 'full' : columns >= 34 && rows >= 6 ? 'line' : 'small'; }
export function Ignition({ session, height, columns, onDone, onExit }: { session: Session; height: number; columns: number; onDone(text?: string): void; onExit(): void }) {
  const theme = useTheme(), progress = useEntrance('ignition', IGNITION_MS), finished = useRef(false);
  const callback = useRef(onDone); callback.current = onDone;
  const done = (text?: string) => { if (!finished.current || text) { finished.current = true; callback.current(text); } };
  useEffect(() => { const timer = setTimeout(() => done(), IGNITION_MS); return () => clearTimeout(timer); }, []);
  useInput((input, key) => { if (key.ctrl && input === 'c') return onExit(); done(input && !key.ctrl && !key.meta && !key.return && !key.escape && !key.tab && !key.upArrow && !key.downArrow ? input : undefined); });
  const size = ignitionSize(columns, height + 1), time = progress * IGNITION_MS;
  const cwd = session.log.header.cwd, branch = gitBranch(cwd);
  const facts = `${session.providerName}:${session.model} · ${path.basename(cwd)}${branch ? ` ⎇ ${branch}` : ''} · ${session.config.swarm.maxAgents} agents · worktree ${session.config.swarm.worktrees === false ? '关' : '开'}`;
  return <Box height={height} width={columns} flexDirection="column" alignItems="center" justifyContent="center" overflow="hidden">
    {size === 'full' ? HONEYCOMB.map((line, row) => <Text key={row} wrap="truncate-end">{[...line].map((ch, col) => {
      const distance = Math.hypot((col - 10) / 10, (row - 2.5) / 3) / 1.5;
      const queen = row >= 2 && row <= 3 && col >= 7 && col <= 12;
      return <Text key={col} color={queen && time >= 480 ? theme.accent2 : theme.gradient[Math.min(theme.gradient.length - 1, Math.floor(distance * theme.gradient.length))]} bold={queen && time >= 480} dimColor={distance > time / 320}>{ch}</Text>;
    })}{'   '}{gradientChars(row < 5 ? ROAST_LOGO[row]! : `    H  I  V  E    v${VERSION}`, theme.gradient).map((part, col) => <Text key={col} color={row === 5 ? theme.accent2 : part.color} bold={row === 5} dimColor={row === 5 ? time < 480 : false}>{row === 5 || col / 30 <= (time - 160) / 320 ? part.ch : ' '}</Text>)}</Text>) : <Text bold wrap="truncate-end">{gradientChars(truncateDisplay(size === 'line' ? `ROAST HIVE v${VERSION}` : 'ROAST', columns), theme.gradient).map((part, col) => <Text key={col} color={part.color} dimColor={col / 20 > progress}>{part.ch}</Text>)}</Text>}
    {size === 'full' ? <><Text> </Text><Text color={motionColor(theme.border, theme.muted, Math.max(0, (time - 480) / 160))} dimColor={time < 560} wrap="truncate-end">{time >= 480 ? truncateDisplay(terminalText(facts), columns) : ' '}</Text></> : null}
  </Box>;
}
