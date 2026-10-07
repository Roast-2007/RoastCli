import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import { useTerminal } from '../terminal.js';
import { motionColor, useEntrance } from '../motion.js';
import { terminalText } from '../../core/terminal-text.js';
import { wrapDisplay, truncateDisplay } from '../../core/text-width.js';
import type { Line, LineTone } from './lines.js';
import type { OutputRow } from '../output-rows.js';
import { OutputLine } from '../components/OutputLine.js';
export function paneMetrics(width: number, height: number) {
  const border = height >= 4 && width >= 8;
  return {
    border,
    inset: border ? 2 : 0,
    titleRow: border ? 1 : 0,
    width: Math.max(1, width - (border ? 4 : 0)),
    count: Math.max(0, height - (border ? 3 : 1)),
  };
}
export function paneLines(lines: Line[], width: number, height: number, singleLine = false): Line[] {
  const metrics = paneMetrics(width, height);
  return lines.flatMap((line) =>
    (singleLine
      ? [truncateDisplay(terminalText(line.text).replace(/[\r\n\t]/g, ' '), metrics.width)]
      : wrapDisplay(terminalText(line.text), metrics.width)
    ).map((text) => ({ ...line, text })),
  );
}
export function paneMaxOffset(lines: Line[], width: number, height: number, singleLine = false): number {
  return Math.max(0, paneLines(lines, width, height, singleLine).length - Math.max(0, height - (height >= 4 && width >= 8 ? 3 : 1)));
}
export function Pane({
  title,
  lines,
  rows,
  pinned = [],
  height,
  width,
  focused,
  offset = 0,
  fromTop = false,
  singleLine = false,
  titleContent,
  children,
}: {
  title: string;
  height: number;
  width: number;
  pinned?: Line[];
  focused?: boolean;
  offset?: number;
  fromTop?: boolean;
  singleLine?: boolean;
  titleContent?: React.ReactNode;
  children?: React.ReactNode;
} & ({ lines: Line[]; rows?: never } | { rows: OutputRow[]; lines?: never })) {
  const theme = useTheme(),
    { ascii } = useTerminal();
  const border = height >= 4 && width >= 8;
  const accent = motionColor(theme.border, theme.accent, useEntrance(focused ? 'focus' : 'blur'));
  const pinnedRows = paneLines(pinned, width, height).slice(0, Math.max(0, height - (border ? 3 : 1)));
  const count = Math.max(0, height - (border ? 3 : 1) - pinnedRows.length);
  const wrapped = rows ?? paneLines(lines ?? [], width, height, singleLine);
  offset = Math.max(0, Math.min(offset, Math.max(0, wrapped.length - count)));
  const max = Math.max(0, wrapped.length - count),
    start = fromTop ? offset : max - offset;
  const view = { shown: wrapped.slice(start, start + count), offset: fromTop ? 0 : offset };
  const color = (tone: LineTone) =>
    tone === 'user'
      ? theme.user
      : tone === 'accent' || tone === 'tool'
        ? theme.accent
        : tone === 'ok'
          ? theme.success
          : tone === 'error'
            ? theme.danger
            : tone === 'warn'
              ? theme.warn
              : undefined;
  return (
    <Box
      width={width}
      height={height}
      flexShrink={0}
      overflow="hidden"
      flexDirection="column"
      borderStyle={border ? (ascii ? 'classic' : 'round') : undefined}
      borderColor={focused ? accent : theme.border}
      paddingX={border ? 1 : 0}
    >
      <Text color={focused ? theme.accent : theme.muted} bold wrap="truncate-end">
        {focused ? (ascii ? '> ' : '▸ ') : '  '}
        {view.offset ? `↑ 已上翻 ${view.offset} 行 · ` : ''}
        {titleContent ?? terminalText(title)}
      </Text>
      {pinnedRows.map((line, index) => (
        <Text key={`pinned:${index}`} color={color(line.tone)} dimColor={line.tone === 'muted'} wrap="truncate-end">
          {terminalText(line.text)}
        </Text>
      ))}
      {children ??
        view.shown.map((line, index) =>
          'spans' in line ? (
            <OutputLine key={index} row={line} />
          ) : (
            <Text key={index} color={color(line.tone)} dimColor={line.tone === 'muted'} wrap="truncate-end">
              {line.mutedSuffix ? (
                <>
                  {terminalText(line.text.slice(0, -line.mutedSuffix.length))}
                  <Text dimColor>{line.mutedSuffix}</Text>
                </>
              ) : (
                terminalText(line.text) || ' '
              )}
            </Text>
          ),
        )}
    </Box>
  );
}
