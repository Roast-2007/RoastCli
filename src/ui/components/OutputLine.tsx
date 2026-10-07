import { Text } from 'ink';
import { terminalText } from '../../core/terminal-text.js';
import type { OutputRow } from '../output-rows.js';
import { useTheme } from '../theme.js';
export function OutputLine({ row }: { row: OutputRow }) {
  const theme = useTheme();
  return (
    <Text wrap="truncate-end">
      {row.spans.length
        ? row.spans.map((span, i) => (
            <Text
              key={i}
              color={span.color ? (theme[span.color] as string | undefined) : undefined}
              bold={span.bold}
              dimColor={span.dim}
              italic={span.italic}
              underline={span.underline}
              strikethrough={span.strike}
            >
              {terminalText(span.text)}
            </Text>
          ))
        : ' '}
    </Text>
  );
}
