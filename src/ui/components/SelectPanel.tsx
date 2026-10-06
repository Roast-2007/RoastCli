import { absoluteOrigin } from '../input/cursor.js';
import { useViewport } from '../viewport.js';
import { useLayoutEffect, useRef, useState } from 'react';
import { Box, Text, useInput, usePaste, useBoxMetrics, type DOMElement } from 'ink';
import { terminalText } from '../../core/terminal-text.js';
import { previousBoundary } from '../../core/text-width.js';
import { useTheme } from '../theme.js';
import { useGlyphs, useTerminal } from '../terminal.js';
import { panelLayout } from '../scroll.js';
import { mouseWheel, parseMouse, createDoubleClick } from '../mouse.js';
import { motionColor, useEntrance } from '../motion.js';

export interface SelectEntry { id: string; label: string; detail?: string }
const oneLine = (text: string) => terminalText(text).replace(/\s+/g, ' ');

/** A shared, scrollable keyboard menu. Search never enters conversation history. */
export function SelectPanel({ title, entries, height, onSelect, onClose, initialId, message, footer, onRefresh, searchable = false }: {
  title: string; entries: SelectEntry[]; height: number; onSelect(entry: SelectEntry): void | Promise<void>; onClose(): void;
  initialId?: string; message?: string; footer?: string; onRefresh?(): void; searchable?: boolean;
}) {
  const theme = useTheme(), glyph = useGlyphs(), { ascii, mouse } = useTerminal();
  const { columns } = useViewport();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(initialId ?? entries[0]?.id ?? '');
  const inputState = useRef({ query, selected });
  inputState.current = { query, selected };
  const [error, setError] = useState('');
  const pending = useRef(false);
  const box = useRef<DOMElement>(null), doubleClick = useRef(createDoubleClick());
  useBoxMetrics(box);
  const items = entries.filter((entry) => `${entry.label} ${entry.detail ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const index = Math.max(0, items.findIndex((entry) => entry.id === selected));
  const layout = panelLayout(height, columns, Number(searchable) + Number(Boolean(error || message)));
  const { border, count } = layout;
  const accent = motionColor(theme.border, theme.accent, useEntrance(title));
  const selection = motionColor(theme.accent, theme.accent2, useEntrance(selected));
  const [scrollStart, setScrollStart] = useState(() => Math.max(0, index - count + 1));
  const first = Math.max(0, Math.min(scrollStart, Math.max(0, items.length - count)));
  useLayoutEffect(() => { setScrollStart(value => Math.max(0, Math.min(index < value ? index : index >= value + count ? index - count + 1 : value, Math.max(0, items.length - count)))); }, [count, items.length]);
  const updateQuery = (value: string) => {
    inputState.current.query = value; inputState.current.selected = '';
    setQuery(value); setSelected(''); setScrollStart(0);
  };
  const search = (text: string) => updateQuery(inputState.current.query + terminalText(text).replace(/[\n\t]/g, ''));
  usePaste(search, { isActive: searchable });
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) return onClose();
    if (pending.current) return;
    if (key.ctrl && input === 'r' && onRefresh) return onRefresh();
    const current = inputState.current;
    const items = entries.filter((entry) => `${entry.label} ${entry.detail ?? ''}`.toLocaleLowerCase().includes(current.query.toLocaleLowerCase()));
    const index = Math.max(0, items.findIndex((entry) => entry.id === current.selected));
    const move = (next: number, reveal = true) => {
      next = Math.max(0, Math.min(items.length - 1, next));
      if (reveal) setScrollStart(value => Math.max(0, Math.min(next < value ? next : next >= value + count ? next - count + 1 : value, Math.max(0, items.length - count))));
      current.selected = items[Math.max(0, Math.min(items.length - 1, next))]?.id ?? '';
      setSelected(current.selected); setError('');
    };
    const events = parseMouse(input);
    if (events.length) {
      if (mouse === false) return;
      const origin = absoluteOrigin(box.current);
      if (!origin) return;
      for (const event of events) {
        if (event.x < origin.x || event.x >= origin.x + columns || event.y < origin.y || event.y >= origin.y + height) continue;
        if (event.kind === 'wheel') { const delta = event.delta ?? 0; setScrollStart(value => Math.max(0, Math.min(Math.max(0, items.length - count), value + delta))); move(index + delta, false); continue; }
        if (event.kind !== 'press' || event.button !== 'left') continue;
        const row = event.y - origin.y - Number(border) - layout.header - layout.extra;
        const entry = row >= 0 && row < count ? items[first + row] : undefined;
        if (!entry) continue;
        move(first + row, false);
        if (doubleClick.current(entry.id)) {
          pending.current = true;
          try { void Promise.resolve(onSelect(entry)).catch(err => setError(err instanceof Error ? err.message : '操作失败')).finally(() => { pending.current = false; }); }
          catch (err) { pending.current = false; setError(err instanceof Error ? err.message : '操作失败'); }
        }
      }
      return;
    }
    if (key.upArrow) return move(index - 1);
    const wheel = mouseWheel(input);
    if (wheel !== null) return move(index + wheel);
    if (key.downArrow || key.tab) return move(index + (key.shift ? -1 : 1));
    if (key.pageUp) return move(index - count);
    if (key.pageDown) return move(index + count);
    if (key.home) return move(0);
    if (key.end) return move(items.length - 1);
    if (key.return && items[index]) {
      pending.current = true;
      try {
        // Keep synchronous navigation inside Ink's discrete input event so the
        // next page and its input listeners transition at the same priority.
        void Promise.resolve(onSelect(items[index]!)).catch((err) => setError(err instanceof Error ? err.message : '操作失败')).finally(() => { pending.current = false; });
      } catch (err) {
        pending.current = false;
        setError(err instanceof Error ? err.message : '操作失败');
      }
      return;
    }
    if (searchable) {
      if (key.backspace || key.delete) return updateQuery(current.query.slice(0, previousBoundary(current.query, current.query.length)));
      if (key.ctrl && input === 'u') return updateQuery('');
      if (input && !key.ctrl && !key.meta) search(input);
    }
  });
  return <Box ref={box} width={columns} flexDirection="column" height={height} flexShrink={0} overflow="hidden" borderStyle={border ? ascii ? 'classic' : 'round' : undefined} borderColor={accent} paddingX={border ? 1 : 0}>
    {layout.header ? <Text bold color={accent} wrap="truncate-end">{oneLine(title)}</Text> : null}
    {searchable && layout.extra > 0 ? <Text dimColor wrap="truncate-end">搜索：{query || '直接输入关键词'} · {items.length} 项</Text> : null}
    {(error || message) && layout.extra > Number(searchable) ? <Text color={error ? theme.danger : theme.muted} wrap="truncate-end">{oneLine(error || message!)}</Text> : null}
    <Box flexDirection="column" height={count} flexShrink={0} overflow="hidden">
      {items.length ? items.slice(first, first + count).map((entry, offset) => <Text key={entry.id} color={index === first + offset ? selection : undefined} bold={index === first + offset} wrap="truncate-end">{index === first + offset ? `${glyph.pointer} ` : '  '}{oneLine(entry.label)}</Text>) : <Text dimColor wrap="truncate-end">没有匹配项{onRefresh ? ' · Ctrl+R 重试' : ''}</Text>}
    </Box>
    {layout.footer ? <Text color={error && layout.extra <= Number(searchable) ? theme.danger : theme.muted} wrap="truncate-end">{error && layout.extra <= Number(searchable) ? oneLine(error) : footer ?? `${ascii ? '^/v' : '↑↓'} 选择 · Enter 确认${onRefresh ? ' · Ctrl+R 刷新' : ''} · Esc 返回${items.length > count ? ` · ${index + 1}/${items.length}` : ''}`}</Text> : null}
  </Box>;
}
