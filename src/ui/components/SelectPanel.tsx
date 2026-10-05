import { useRef, useState } from 'react';
import { Box, Text, useInput, usePaste } from 'ink';
import { terminalText } from '../../core/terminal-text.js';
import { previousBoundary } from '../../core/text-width.js';
import { useTheme } from '../theme.js';
import { useGlyphs, useTerminal } from '../terminal.js';

export interface SelectEntry { id: string; label: string; detail?: string }

/** A shared, scrollable keyboard menu. Search never enters conversation history. */
export function SelectPanel({ title, entries, height, onSelect, onClose, initialId, message, footer, onRefresh, searchable = false }: {
  title: string; entries: SelectEntry[]; height: number; onSelect(entry: SelectEntry): void | Promise<void>; onClose(): void;
  initialId?: string; message?: string; footer?: string; onRefresh?(): void; searchable?: boolean;
}) {
  const theme = useTheme(), glyph = useGlyphs(), { ascii } = useTerminal();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(initialId ?? entries[0]?.id ?? '');
  const inputState = useRef({ query, selected });
  inputState.current = { query, selected };
  const [error, setError] = useState('');
  const pending = useRef(false);
  const items = entries.filter((entry) => `${entry.label} ${entry.detail ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const index = Math.max(0, items.findIndex((entry) => entry.id === selected));
  const border = height >= 6;
  const headerRows = 1 + (searchable && height >= 5 ? 1 : 0) + ((error || message) && height >= 6 ? 1 : 0);
  const count = Math.max(1, height - (border ? 2 : 0) - headerRows - 1);
  const first = Math.max(0, index - count + 1);
  const updateQuery = (value: string) => {
    inputState.current.query = value; inputState.current.selected = '';
    setQuery(value); setSelected('');
  };
  const search = (text: string) => updateQuery(inputState.current.query + terminalText(text).replace(/[\n\t]/g, ''));
  usePaste(search, { isActive: searchable });
  useInput((input, key) => {
    if (pending.current) return;
    if (key.escape || (key.ctrl && input === 'c')) return onClose();
    if (key.ctrl && input === 'r' && onRefresh) return onRefresh();
    const current = inputState.current;
    const items = entries.filter((entry) => `${entry.label} ${entry.detail ?? ''}`.toLocaleLowerCase().includes(current.query.toLocaleLowerCase()));
    const index = Math.max(0, items.findIndex((entry) => entry.id === current.selected));
    const move = (next: number) => {
      current.selected = items[Math.max(0, Math.min(items.length - 1, next))]?.id ?? '';
      setSelected(current.selected); setError('');
    };
    if (key.upArrow) return move(index - 1);
    if (key.downArrow || key.tab) return move(index + (key.shift ? -1 : 1));
    if (key.pageUp) return move(index - count);
    if (key.pageDown) return move(index + count);
    if (key.home) return move(0);
    if (key.end) return move(items.length - 1);
    if (key.return && items[index]) {
      pending.current = true;
      void Promise.resolve().then(() => onSelect(items[index]!)).catch((err) => setError(err instanceof Error ? err.message : '操作失败')).finally(() => { pending.current = false; });
      return;
    }
    if (searchable) {
      if (key.backspace || key.delete) return updateQuery(current.query.slice(0, previousBoundary(current.query, current.query.length)));
      if (key.ctrl && input === 'u') return updateQuery('');
      if (input && !key.ctrl && !key.meta) search(input);
    }
  });
  return <Box flexDirection="column" height={height} flexShrink={0} overflow="hidden" borderStyle={border ? ascii ? 'classic' : 'round' : undefined} borderColor={theme.accent} paddingX={border ? 1 : 0}>
    <Text bold color={theme.accent} wrap="truncate-end">{terminalText(title)}</Text>
    {searchable && height >= 5 ? <Text dimColor wrap="truncate-end">搜索：{query || '直接输入关键词'} · {items.length} 项</Text> : null}
    {(error || message) && height >= 6 ? <Text color={error ? theme.danger : theme.muted} wrap="truncate-end">{terminalText(error || message!)}</Text> : null}
    <Box flexDirection="column" height={count} flexShrink={0} overflow="hidden">
      {items.length ? items.slice(first, first + count).map((entry, offset) => <Text key={entry.id} color={index === first + offset ? theme.accent2 : undefined} wrap="truncate-end">{index === first + offset ? `${glyph.pointer} ` : '  '}{terminalText(entry.label)}</Text>) : <Text dimColor>没有匹配项{onRefresh ? ' · Ctrl+R 重试' : ''}</Text>}
    </Box>
    <Text color={error && height < 6 ? theme.danger : theme.muted} wrap="truncate-end">{error && height < 6 ? terminalText(error) : footer ?? `↑↓ 选择 · Enter 确认${onRefresh ? ' · Ctrl+R 刷新' : ''} · Esc 返回`}</Text>
  </Box>;
}
