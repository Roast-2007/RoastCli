/**
 * Markdown → Ink 组件：标题、段落（粗体/斜体/行内代码/链接/删除线）、列表（含嵌套）、
 * 代码块（cli-highlight 高亮）、引用、表格（按显示宽度对齐）、分隔线。
 */
import { createContext, useContext, memo, type ReactNode } from 'react';
import { Box, Text } from 'ink';
import { marked, type Token, type Tokens } from 'marked';
import { highlight, supportsLanguage } from 'cli-highlight';
import { displayWidth, useTheme, type Theme } from '../theme.js';
import { truncateDisplay } from '../../core/text-width.js';
import { terminalText } from '../../core/terminal-text.js';
import { useTerminal } from '../terminal.js';
import type { RoastConfig } from '../../core/config.js';

const MarkdownLayout = createContext({ width: 80, spacing: 1 });

function inline(tokens: Token[] | undefined, theme: Theme, keyPrefix = 'i'): ReactNode[] {
  if (!tokens) return [];
  return tokens.map((t, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (t.type) {
      case 'strong':
        return (
          <Text key={key} bold>
            {inline((t as Tokens.Strong).tokens, theme, key)}
          </Text>
        );
      case 'em':
        return (
          <Text key={key} italic>
            {inline((t as Tokens.Em).tokens, theme, key)}
          </Text>
        );
      case 'del':
        return (
          <Text key={key} strikethrough>
            {inline((t as Tokens.Del).tokens, theme, key)}
          </Text>
        );
      case 'codespan':
        return (
          <Text key={key} color={theme.accent2}>
            {(t as Tokens.Codespan).text}
          </Text>
        );
      case 'link': {
        const link = t as Tokens.Link;
        return (
          <Text key={key}>
            <Text underline color={theme.info}>
              {inline(link.tokens, theme, key)}
            </Text>
            {link.href && link.href !== link.text ? <Text dimColor> ({link.href})</Text> : null}
          </Text>
        );
      }
      case 'br':
        return <Text key={key}>{'\n'}</Text>;
      case 'escape':
      case 'text': {
        const tt = t as Tokens.Text;
        return tt.tokens ? <Text key={key}>{inline(tt.tokens, theme, key)}</Text> : <Text key={key}>{decode(tt.text)}</Text>;
      }
      default:
        return <Text key={key}>{decode((t as { raw?: string }).raw ?? '')}</Text>;
    }
  });
}

function decode(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function CodeBlock({ token }: { token: Tokens.Code }) {
  const theme = useTheme();
  const { ascii } = useTerminal();
  const lang = token.lang?.split(/\s/)[0] ?? '';
  let body = token.text;
  if (theme.name !== 'mono' && lang && supportsLanguage(lang)) {
    try {
      body = highlight(token.text, { language: lang, ignoreIllegals: true });
    } catch {
      body = token.text;
    }
  }
  return (
    <Box flexDirection="column" borderStyle={ascii ? 'classic' : 'round'} borderColor={theme.border} paddingX={1}>
      {lang ? <Text color={theme.muted}>{lang}</Text> : null}
      <Text>{body}</Text>
    </Box>
  );
}

function ListBlock({ token, depth }: { token: Tokens.List; depth: number }) {
  const theme = useTheme();
  const { ascii } = useTerminal();
  const start = typeof token.start === 'number' ? token.start : 1;
  const { spacing } = useContext(MarkdownLayout);
  return (
    <Box flexDirection="column">
      {token.items.map((item, i) => {
        const bullet = token.ordered ? `${start + i}.` : ascii ? '-' : depth === 0 ? '•' : '◦';
        const mark = item.task ? ascii ? item.checked ? '[x] ' : '[ ] ' : item.checked ? '☑ ' : '☐ ' : '';
        return (
          <Box key={i} marginBottom={depth === 0 && i < token.items.length - 1 ? spacing : 0}>
            <Box flexShrink={0}><Text color={theme.accent}>{bullet} </Text></Box>
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              {item.tokens.filter((child) => child.type !== 'checkbox').map((child, j) =>
                child.type === 'list' ? (
                  <ListBlock key={j} token={child as Tokens.List} depth={depth + 1} />
                ) : (
                  <Text key={j}>
                    {mark && j === 0 ? mark : ''}
                    {inline((child as Tokens.Text).tokens ?? [child], theme, `l${i}-${j}`)}
                  </Text>
                ),
              )}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

function TableBlock({ token }: { token: Tokens.Table }) {
  const theme = useTheme();
  const { ascii } = useTerminal();
  const { width: columns } = useContext(MarkdownLayout);
  const rows = [token.header.map((c) => c.text), ...token.rows.map((r) => r.map((c) => c.text))];
  const budget = Math.max(1, Math.floor((columns - (token.header.length - 1) * 3) / Math.max(1, token.header.length)));
  const widths = token.header.map((_, col) => Math.min(budget, Math.max(...rows.map((r) => displayWidth(r[col] ?? '')))));
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - displayWidth(s)));
  const line = (r: string[]) => r.map((c, i) => pad(truncateDisplay(c, widths[i]!), widths[i]!)).join(ascii ? ' | ' : ' │ ');
  return (
    <Box flexDirection="column">
      <Text bold wrap="truncate-end">{line(rows[0]!)}</Text>
      <Text color={theme.border} wrap="truncate-end">{widths.map((w) => (ascii ? '-' : '─').repeat(w)).join(ascii ? '-+-' : '─┼─')}</Text>
      {rows.slice(1).map((r, i) => (
        <Text key={i} wrap="truncate-end">{line(r)}</Text>
      ))}
    </Box>
  );
}

function BlockToken({ token }: { token: Token }) {
  const theme = useTheme();
  const { ascii } = useTerminal();
  switch (token.type) {
    case 'heading': {
      const h = token as Tokens.Heading;
      return (
        <Text bold color={h.depth <= 2 ? theme.accent : undefined}>
          {h.depth <= 2 ? ascii ? '# ' : '▍' : ''}
          {inline(h.tokens, theme)}
        </Text>
      );
    }
    case 'paragraph':
      return <Text>{inline((token as Tokens.Paragraph).tokens, theme)}</Text>;
    case 'code':
      return <CodeBlock token={token as Tokens.Code} />;
    case 'list':
      return <ListBlock token={token as Tokens.List} depth={0} />;
    case 'blockquote':
      return (
        <Box borderStyle={ascii ? 'classic' : 'bold'} borderLeft borderTop={false} borderRight={false} borderBottom={false} borderColor={theme.muted} paddingLeft={1}>
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>{(token as Tokens.Blockquote).tokens.filter((child) => child.type !== 'space').map((child, index) => <BlockToken key={index} token={child} />)}</Box>
        </Box>
      );
    case 'table':
      return <TableBlock token={token as Tokens.Table} />;
    case 'hr':
      return <RuleBlock />;
    case 'space':
      return null;
    default:
      return <Text>{decode((token as { raw?: string }).raw ?? '').trimEnd()}</Text>;
  }
}

function RuleBlock() {
  const theme = useTheme();
  const { ascii } = useTerminal();
  const { width: columns } = useContext(MarkdownLayout);
  return <Text color={theme.border}>{(ascii ? '-' : '─').repeat(Math.min(40, Math.max(1, columns)))}</Text>;
}

/** 渲染一段 markdown（通常是 splitStreaming 给出的一个已完成块，或流式尾巴） */
export const Markdown = memo(function Markdown({ text, preferences, compact = false, columns = 80 }: { text: string; preferences?: NonNullable<RoastConfig['ui']>['markdown']; compact?: boolean; columns?: number }) {
  const padding = Math.min(preferences?.padding ?? (columns >= 60 ? 2 : columns >= 30 ? 1 : 0), Math.max(0, Math.floor((columns - 12) / 2)));
  const width = Math.max(1, columns - padding * 2);
  const spacing = compact ? 0 : preferences?.spacing ?? 1;
  const tokens = marked.lexer(terminalText(text)).filter((token) => token.type !== 'space');
  if (!tokens.length) return null;
  return (
    <MarkdownLayout.Provider value={{ width, spacing }}><Box flexDirection="column" paddingX={padding}>
      {tokens.map((t, i) => (
        <Box key={i} flexDirection="column" marginBottom={spacing}><BlockToken token={t} /></Box>
      ))}
    </Box></MarkdownLayout.Provider>
  );
});
