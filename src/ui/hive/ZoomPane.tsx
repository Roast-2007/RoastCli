import { Box, Text } from 'ink';
import { terminalText } from '../../core/terminal-text.js';
import { OutputLine } from '../components/OutputLine.js';
import type { OutputRow } from '../output-rows.js';
import { useTheme } from '../theme.js';
import type { Line } from './lines.js';

export function ZoomPane({
  title,
  rows,
  start,
  count,
  height,
  width,
  padding,
}: {
  title: string;
  rows: (OutputRow | Line)[];
  start: number;
  count: number;
  height: number;
  width: number;
  padding: number;
}) {
  const theme = useTheme();
  return (
    <Box height={height} width={width} flexDirection="column" overflow="hidden">
      <Text bold color={theme.accent} wrap="truncate-end">
        {terminalText(title)}
      </Text>
      <Box height={count} paddingX={padding} flexDirection="column" overflow="hidden">
        {rows.slice(start, start + count).map((row, index) =>
          'spans' in row ? (
            <OutputLine key={index} row={row} />
          ) : (
            <Text
              key={index}
              wrap="truncate-end"
              color={row.tone === 'accent' || row.tone === 'tool' ? theme.accent : undefined}
              dimColor={row.tone === 'muted'}
            >
              {terminalText(row.text) || ' '}
            </Text>
          ),
        )}
      </Box>
    </Box>
  );
}
