import { useViewport } from '../viewport.js';
/**
 * 工具卡片：一行摘要（状态图标 · 工具名 · 关键参数 · 耗时），
 * 写类工具附带 diff，bash 运行中显示实时输出尾部，失败显示错误预览。
 */
import { Box, Text, useInput } from 'ink';
import type { DiffMeta } from '../../tools/file-ops.js';
import type { ToolView } from '../store/reducer.js';
import { useTheme } from '../theme.js';
import { useTerminal, useGlyphs } from '../terminal.js';
import { useSpinner } from './useSpinner.js';
import { terminalText } from '../../core/terminal-text.js';
import { wrapDisplay } from '../../core/text-width.js';
import { panelLayout, useScroll } from '../scroll.js';
import { motionColor, useEntrance } from '../motion.js';

const MAX_DIFF_LINES = 24;
const LIVE_LINES = 6;

function oneLine(s: string, max = 80): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 各工具最有信息量的参数摘要 */
export function argSummary(name: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '');
  switch (name) {
    case 'read':
    case 'edit':
    case 'multi_edit':
    case 'write':
    case 'ls':
      return s('path') || '.';
    case 'bash':
      return oneLine(s('command'));
    case 'grep':
      return `/${s('pattern')}/${s('path') ? ` in ${s('path')}` : ''}`;
    case 'glob':
      return s('pattern');
    case 'web_fetch':
      return s('url');
    case 'todo_write':
      return Array.isArray(a['todos']) ? `${(a['todos'] as unknown[]).length} 项` : '';
    case 'ask_user':
      return oneLine(s('question'));
    case 'recall':
      return s('handle') || s('query');
    default:
      return oneLine(JSON.stringify(args ?? {}), 60);
  }
}

function duration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function DiffView({ diff }: { diff: DiffMeta }) {
  const theme = useTheme();
  const rows: { text: string; color: string | undefined; dim: boolean }[] = [];
  for (const h of diff.hunks) {
    let oldNo = h.oldStart;
    let newNo = h.newStart;
    for (const l of h.lines) {
      const sign = l[0];
      const body = l.slice(1);
      if (sign === '-') rows.push({ text: `${String(oldNo++).padStart(4)} - ${body}`, color: theme.danger, dim: false });
      else if (sign === '+') rows.push({ text: `${String(newNo++).padStart(4)} + ${body}`, color: theme.success, dim: false });
      else if (sign === ' ') {
        rows.push({ text: `${String(newNo).padStart(4)}   ${body}`, color: undefined, dim: true });
        oldNo++;
        newNo++;
      }
    }
  }
  const shown = rows.slice(0, MAX_DIFF_LINES);
  const hidden = rows.length - shown.length + (diff.truncated ? 1 : 0);
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {shown.map((r, i) => (
        <Text key={i} color={r.color} dimColor={r.dim} wrap="truncate-end">
          {terminalText(r.text)}
        </Text>
      ))}
      {hidden > 0 ? <Text dimColor>    … 另有 {rows.length - shown.length} 行改动未显示</Text> : null}
    </Box>
  );
}

function StatusIcon({ status }: { status: ToolView['status'] }) {
  const theme = useTheme();
  const glyph = useGlyphs();
  const frame = useSpinner(status === 'running');
  switch (status) {
    case 'running':
      return <Text color={theme.accent}>{frame}</Text>;
    case 'done':
      return <Text color={theme.success}>{glyph.ok}</Text>;
    case 'error':
      return <Text color={theme.danger}>{glyph.error}</Text>;
    case 'interrupted':
      return <Text color={theme.warn}>{glyph.cancelled}</Text>;
  }
}

/** Ctrl+O：最近一个工具的完整输出（活动区内显示，高度受限以免触发整屏重绘） */
export function ToolDetail({ tool, maxLines, active = false, width }: { tool: ToolView | undefined; maxLines: number; active?: boolean; width?: number }) {
  const theme = useTheme();
  const { ascii } = useTerminal();
  const { columns } = useViewport();
  const layout = panelLayout(maxLines, width ?? columns), { count, border } = layout;
  const lines = wrapDisplay(terminalText(tool?.output ?? tool?.preview ?? ''), layout.width);
  const scroll = useScroll(lines.length, count), { start } = scroll;
  const accent = motionColor(theme.border, theme.accent, useEntrance(tool?.callId));
  useInput((input, key) => {
    scroll.onKey(input, key);
  }, { isActive: active });
  if (!tool) return <Text dimColor>还没有工具输出（Ctrl+O 关闭）</Text>;
  const shown = lines.slice(start, start + count);
  return (
    <Box height={Math.max(1, maxLines)} flexShrink={0} overflow="hidden" flexDirection="column" borderStyle={border ? ascii ? 'classic' : 'round' : undefined} borderColor={accent} paddingX={border ? 1 : 0}>
      {layout.header ? <Text wrap="truncate-end">
        <Text color={theme.tool} bold>{terminalText(tool.name)}</Text> <Text>{terminalText(argSummary(tool.name, tool.args)).replace(/\s+/g, ' ')}</Text>
        <Text dimColor>  · Ctrl+O 关闭</Text>
      </Text> : null}
      <Box height={count} flexShrink={0} flexDirection="column">{shown.map((l, i) => (
        <Text key={i} color={tool.status === 'error' ? theme.danger : undefined} wrap="truncate-end">
          {l || ' '}
        </Text>
      ))}</Box>
      {layout.footer ? <Text dimColor wrap="truncate-end">↑↓ 滚动 · {start + 1}–{start + shown.length}/{lines.length} 行 · Ctrl+O 关闭</Text> : null}
    </Box>
  );
}

export function ToolCard({ tool, maxHeight }: { tool: ToolView; maxHeight?: number }) {
  const theme = useTheme();
  const diff = tool.metadata?.['diff'] as DiffMeta | undefined;
  const liveCount = Math.max(0, (maxHeight ?? LIVE_LINES + 1) - 1);
  const live = tool.status === 'running' && tool.live && liveCount > 0 ? terminalText(tool.live).split('\n').filter(Boolean).slice(-liveCount) : [];
  const stat = diff ? ` +${diff.added} -${diff.removed}` : '';
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <StatusIcon status={tool.status} /> <Text color={theme.tool} bold>{terminalText(tool.name)}</Text> <Text>{terminalText(argSummary(tool.name, tool.args)).replace(/\s+/g, ' ')}</Text>
        <Text color={theme.success}>{stat}</Text>
        {tool.status !== 'running' ? <Text dimColor> {duration(tool.durationMs)}</Text> : null}
        {tool.status === 'interrupted' ? <Text color={theme.warn}> 已中断</Text> : null}
      </Text>
      {live.length > 0 ? (
        <Box flexDirection="column" paddingLeft={2}>
          {live.map((l, i) => (
            <Text key={i} dimColor wrap="truncate-end">
              {l}
            </Text>
          ))}
        </Box>
      ) : null}
      {tool.status === 'error' && tool.preview ? (
        <Box paddingLeft={2}>
          <Text color={theme.danger}>{oneLine(terminalText(tool.preview), 160)}</Text>
        </Box>
      ) : null}
      {tool.status === 'done' && diff && diff.hunks.length > 0 ? <DiffView diff={diff} /> : null}
    </Box>
  );
}
