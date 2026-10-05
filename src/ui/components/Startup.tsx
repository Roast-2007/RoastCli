import { useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { VERSION } from '../../core/version.js';
import { truncateDisplay } from '../../core/text-width.js';
import { gradientChars, useTheme } from '../theme.js';
import { useEntrance } from '../motion.js';

export const ROAST_LOGO = [
  ' ____   ___    _    ____ _____ ',
  '|  _ \\ / _ \\  / \\  / ___|_   _|',
  '| |_) | | | |/ _ \\ \\___ \\ | |  ',
  '|  _ <| |_| / ___ \\ ___) || |  ',
  '|_| \\_\\\\___/_/   \\_\\____/ |_|  ',
];

export function Startup({ height, columns, onDone, onExit }: { height: number; columns: number; onDone(text?: string): void; onExit(): void }) {
  const theme = useTheme();
  const progress = useEntrance('startup', 704);
  const finished = useRef(false);
  const done = (text?: string) => { if (!finished.current || text) { finished.current = true; onDone(text); } };
  useEffect(() => { if (progress === 1) done(); }, [progress]);
  useInput((input, key) => {
    if (key.ctrl && input === 'c') return onExit();
    // The first typed character is handed to the editor when skipping the splash.
    done(input && !key.ctrl && !key.meta && !key.return && !key.escape ? input : undefined);
  });
  const logo = height >= 9 && columns >= 34 ? ROAST_LOGO : ['R O A S T'];
  const width = Math.min(30, Math.max(1, columns - 4));
  const filled = Math.round(progress * width);
  return <Box height={height} width={columns} flexDirection="column" alignItems="center" justifyContent="center" overflow="hidden">
    {logo.map((line, row) => <Text key={row} bold wrap="truncate-end">{gradientChars(truncateDisplay(line, columns), theme.gradient).map((part, index) => <Text key={index} color={part.color} dimColor={(index + row * 2) / (line.length + logo.length * 2) > progress}>{part.ch}</Text>)}</Text>)}
    {height >= 4 ? <Text dimColor wrap="truncate-end">{truncateDisplay(`TERMINAL WORKSPACE · v${VERSION}`, columns)}</Text> : null}
    {height >= 7 ? <Text color={theme.accent} wrap="truncate-end">{'='.repeat(filled)}<Text dimColor>{'-'.repeat(width - filled)}</Text></Text> : null}
    {height >= 6 ? <Text dimColor wrap="truncate-end">{truncateDisplay('正在进入工作区 · 任意键跳过', columns)}</Text> : null}
  </Box>;
}
