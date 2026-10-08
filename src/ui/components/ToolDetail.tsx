import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Box, Text, useInput } from 'ink';
import { terminalText } from '../../core/terminal-text.js';
import type { DiffMeta } from '../../tools/file-ops.js';
import type { ToolView } from '../store/reducer.js';
import { panelLayout, useScroll } from '../scroll.js';
import { useViewport } from '../viewport.js';
import { useTerminal } from '../terminal.js';
import { useTheme } from '../theme.js';
import { wrapSpans, type Span } from '../markdown/rows.js';
import { OutputLine } from './OutputLine.js';

export interface ToolDetailActions {
  previous(): void;
  next(): void;
  scroll(): void;
}
/** 参数、完整 diff 与结果共用一个行视口。 */
export function toolDetailRows(tool: ToolView, width: number) {
  const rows: { spans: Span[] }[] = [];
  const add = (text: string, color?: Span['color'], dim = false) =>
    rows.push(...wrapSpans([{ text: terminalText(text), color, dim }], width).map((spans) => ({ spans })));
  add('参数', 'accent');
  const args = (tool.args ?? {}) as Record<string, unknown>;
  add(
    tool.name === 'bash'
      ? String(args['command'] ?? '')
      : ['read', 'ls', 'edit', 'multi_edit', 'write'].includes(tool.name)
        ? String(args['path'] ?? '.')
        : JSON.stringify(tool.args ?? {}, null, 2),
  );
  const diff = tool.metadata?.['diff'] as DiffMeta | undefined;
  if (diff) {
    for (const hunk of diff.hunks) {
      let oldNo = hunk.oldStart,
        newNo = hunk.newStart;
      for (const line of hunk.lines) {
        if (line.startsWith('-')) add(`${String(oldNo++).padStart(4)} - ${line.slice(1)}`, 'danger');
        else if (line.startsWith('+')) add(`${String(newNo++).padStart(4)} + ${line.slice(1)}`, 'success');
        else if (line.startsWith(' ')) {
          add(`${String(newNo++).padStart(4)}   ${line.slice(1)}`, undefined, true);
          oldNo++;
        } else add(line, undefined, true);
      }
    }
    if (diff.truncated) add('… diff 元数据已截断', 'warn');
  }
  add('');
  add('结果', 'accent');
  add(
    (tool.status === 'running' ? tool.live : (tool.output ?? tool.preview)) || '（无输出）',
    tool.status === 'error' ? 'danger' : undefined,
  );
  const diagnostics = tool.metadata?.['diagnostics'] as
    | { file: string; items: { line: number; column: number; code: number; message: string }[] }
    | undefined;
  if (diagnostics?.items?.length) {
    add('TypeScript 诊断', 'warn');
    for (const item of diagnostics.items) add(`${diagnostics.file}:${item.line}:${item.column} TS${item.code} ${item.message}`, 'warn');
  }
  return rows;
}
export function ToolDetail({
  tools,
  callId,
  tool,
  maxLines,
  active = false,
  width,
  scrollAction,
  actions,
}: {
  tools?: ToolView[];
  callId?: string;
  tool?: ToolView;
  maxLines: number;
  active?: boolean;
  width?: number;
  scrollAction?: RefObject<(() => void) | null>;
  actions?: RefObject<ToolDetailActions | null>;
}) {
  const theme = useTheme(),
    { ascii } = useTerminal(),
    { columns } = useViewport();
  const list = tools ?? (tool ? [tool] : []);
  const [selected, setSelected] = useState(callId ?? tool?.callId);
  const selection = useRef(selected);
  selection.current = selected;
  const index = Math.max(
      0,
      list.findIndex((item) => item.callId === selected),
    ),
    current = list[index];
  const layout = panelLayout(maxLines, width ?? columns);
  const rows = current ? toolDetailRows(current, layout.width) : [];
  const scroll = useScroll(rows.length, layout.count);
  useLayoutEffect(() => {
    if (callId !== undefined) {
      selection.current = callId;
      setSelected(callId);
      scroll.move(0);
    }
  }, [callId]);
  const change = (delta: number) => {
    const at = Math.max(
      0,
      list.findIndex((item) => item.callId === selection.current),
    );
    selection.current = list[Math.max(0, Math.min(list.length - 1, at + delta))]?.callId;
    setSelected(selection.current);
    scroll.move(0);
  };
  useLayoutEffect(() => {
    if (scrollAction) scrollAction.current = () => scroll.move(scroll.position() + 1);
    if (actions) actions.current = { previous: () => change(-1), next: () => change(1), scroll: () => scroll.move(scroll.position() + 1) };
    return () => {
      if (scrollAction) scrollAction.current = null;
      if (actions) actions.current = null;
    };
  });
  useInput(
    (input, key) => {
      if (key.leftArrow || input === '[') return change(-1);
      if (key.rightArrow || input === ']') return change(1);
      scroll.onKey(input, key);
    },
    { isActive: active },
  );
  if (!current) return <Text dimColor>还没有工具输出（Esc/Ctrl+O 关闭）</Text>;
  const shown = rows.slice(scroll.start, scroll.start + layout.count);
  const status = { running: '运行中', done: '完成', error: '失败', interrupted: '已中断' }[current.status];
  return (
    <Box
      height={Math.max(1, maxLines)}
      {...(width !== undefined ? { width } : {})}
      flexShrink={0}
      overflow="hidden"
      flexDirection="column"
      borderStyle={layout.border ? (ascii ? 'classic' : 'round') : undefined}
      borderColor={theme.accent}
      paddingX={layout.border ? 1 : 0}
    >
      {layout.header ? (
        <Text wrap="truncate-end" color={theme.tool} bold>
          {terminalText(`工具 ${index + 1}/${list.length} · ${current.name} · ${status} · ${(current.durationMs / 1000).toFixed(1)}s`)}
        </Text>
      ) : null}
      <Box height={layout.count} flexShrink={0} flexDirection="column">
        {shown.map((row, i) => (
          <OutputLine key={i} row={row} />
        ))}
      </Box>
      {layout.footer ? (
        <Text dimColor wrap="truncate-end">
          ←→ 切换工具 · ↑↓ 滚动 · 行 {rows.length ? scroll.start + 1 : 0}–{scroll.start + shown.length}/{rows.length} · Esc/Ctrl+O 关闭
        </Text>
      ) : null}
    </Box>
  );
}
