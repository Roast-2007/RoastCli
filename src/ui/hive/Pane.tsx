import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import { useTerminal } from '../terminal.js';
import { motionColor, useEntrance } from '../motion.js';
import { terminalText } from '../../core/terminal-text.js';
import { wrapDisplay, truncateDisplay } from '../../core/text-width.js';
import { windowLines, type Line, type LineTone } from './lines.js';
export function paneMetrics(width: number, height: number) {
  const border = height >= 4 && width >= 8;
  return { border, inset: border ? 2 : 0, titleRow: border ? 1 : 0, width: Math.max(1, width - (border ? 4 : 0)), count: Math.max(0, height - (border ? 3 : 1)) };
}
export function paneLines(lines: Line[], width: number, height: number, singleLine = false): Line[] {
  const metrics = paneMetrics(width, height);
  return lines.flatMap(line => (singleLine ? [truncateDisplay(terminalText(line.text).replace(/\s+/g, ' '), metrics.width)] : wrapDisplay(terminalText(line.text), metrics.width)).map(text => ({ ...line, text })));
}
export function paneMaxOffset(lines: Line[], width: number, height: number, singleLine = false): number {
  return Math.max(0, paneLines(lines, width, height, singleLine).length - Math.max(0, height - (height >= 4 && width >= 8 ? 3 : 1)));
}
export function Pane({ title, lines, height, width, focused, offset = 0, fromTop = false, singleLine = false, children }: { title: string; lines: Line[]; height: number; width: number; focused?: boolean; offset?: number; fromTop?: boolean; singleLine?: boolean; children?: React.ReactNode }) {
  const theme = useTheme(), { ascii } = useTerminal();
  const border = height >= 4 && width >= 8;
  const accent = motionColor(theme.border, theme.accent, useEntrance(focused ? 'focus' : 'blur'));
  const count = Math.max(0, height - (border ? 3 : 1));
  const wrapped = paneLines(lines, width, height, singleLine);
  offset = Math.max(0, Math.min(offset, Math.max(0, wrapped.length - count)));
  const view = fromTop ? { shown: wrapped.slice(offset, offset + count), offset: 0 } : windowLines(wrapped, count, offset);
  const color = (tone: LineTone) => tone === 'user' ? theme.user : tone === 'accent' || tone === 'tool' ? theme.accent : tone === 'ok' ? theme.success : tone === 'error' ? theme.danger : tone === 'warn' ? theme.warn : undefined;
  return <Box width={width} height={height} flexShrink={0} overflow="hidden" flexDirection="column" borderStyle={border ? ascii ? 'classic' : 'round' : undefined} borderColor={focused ? accent : theme.border} paddingX={border ? 1 : 0}>
    <Text color={focused ? theme.accent : theme.muted} bold wrap="truncate-end">{view.offset ? `↑ 已上翻 ${view.offset} 行 · ` : ''}{terminalText(title)}</Text>
    {children ?? view.shown.map((line, index) => <Text key={index} color={color(line.tone)} dimColor={line.tone === 'muted'} wrap="truncate-end">{line.text || ' '}</Text>)}
  </Box>;
}
