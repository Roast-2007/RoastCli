import { useRef } from 'react';
import { parseMouse } from '../mouse.js';
import { absoluteOrigin } from '../input/cursor.js';
import { useViewport } from '../viewport.js';
/**
 * 界面"外壳"组件：启动横幅、状态栏（模式胶囊 / 模型 / 上下文量规 / 缓存 / 用量 / 计时）、待办面板、回合小结。
 */
import { Box, Text, useInput, useBoxMetrics, type DOMElement } from 'ink';
import type { TokenUsage } from '../../core/types.js';
import type { PermissionMode } from '../../tools/permissions/engine.js';
import type { TodoItem } from '../../tools/interact/index.js';
import type { AgentInfo } from '../../swarm/types.js';
import { useTheme } from '../theme.js';
import { useSpinner } from './useSpinner.js';
import { displayWidth, truncateDisplay } from '../../core/text-width.js';
import { terminalText } from '../../core/terminal-text.js';
import { useTerminal, useGlyphs } from '../terminal.js';
import { VERSION } from '../../core/version.js';
import path from 'node:path';
import { gitBranch } from '../status-info.js';
import { statusText } from '../hive/status.js';

export function Banner({ model, cwd }: { model: string; cwd: string; resumed?: string; warnings: string[] }) {
  const theme = useTheme();
  const { columns } = useViewport();
  const branch = gitBranch(cwd);
  return (
    <Text color={theme.accent} bold wrap="truncate-end">{truncateDisplay(terminalText(`ROAST v${VERSION} · ${model} · ${path.basename(cwd)}${branch ? ` ⎇ ${branch}` : ''}`), columns)}</Text>
  );
}

const MODE: Record<PermissionMode, { text: string; key: keyof ReturnType<typeof useTheme> }> = {
  default: { text: '默认', key: 'muted' },
  acceptEdits: { text: '自动编辑', key: 'success' },
  plan: { text: '计划', key: 'info' },
  yolo: { text: 'YOLO', key: 'danger' },
};

export function modeWidth(mode: PermissionMode) { return displayWidth(` ${MODE[mode].text} `); }

function k(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function Gauge({ percent, width = 10 }: { percent: number; width?: number }) {
  const theme = useTheme();
  const { ascii } = useTerminal();
  percent = Math.max(0, Math.min(100, Number.isFinite(percent) ? Math.round(percent) : 0));
  width = Math.max(0, Math.floor(width));
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  const color = percent >= 80 ? theme.danger : percent >= 60 ? theme.warn : theme.success;
  return (
    <Text>
      <Text color={color}>{(ascii ? '#' : '▰').repeat(filled)}</Text>
      <Text dimColor>{(ascii ? '-' : '▱').repeat(width - filled)}</Text>
      <Text color={color}> {percent}%</Text>
    </Text>
  );
}

export interface StatusLineProps {
  mode: PermissionMode;
  model: string;
  contextPercent: number;
  total: TokenUsage;
  last: TokenUsage | null;
  running: boolean;
  elapsedMs: number;
  step: number;
  /** git 分支（不在仓库中为 null） */
  branch?: string | null;
  /** 估算费用（美元；未配置定价为 null） */
  cost?: string | null;
  toast?: { text: string; tone: 'info' | 'success' | 'warn' | 'error' } | null;
  agents?: number;
  onMode?(): void;
  onHelp?(): void;
}

export function StatusLine(p: StatusLineProps) {
  const box = useRef<DOMElement>(null); useBoxMetrics(box);
  const { mouse } = useTerminal();
  const theme = useTheme();
  const { columns } = useViewport();
  const frame = useSpinner(p.running);
  const glyph = useGlyphs();
  const { ascii } = useTerminal();
  const m = MODE[p.mode];
  const color = theme[m.key] as string | undefined;
  const base = ` ${m.text} `;
  const percent = Math.max(0, Math.min(100, Number.isFinite(p.contextPercent) ? Math.round(p.contextPercent) : 0));
  const hive = p.agents ? ` HIVE ${p.agents} ` : '';
  const parts = statusText(columns, displayWidth(base + hive), { percent, total: p.total, cost: p.cost, branch: p.branch, activity: p.running ? `${frame} ${Math.floor(p.elapsedMs / 1000)}s step ${p.step}` : '', separator: glyph.separator, up: glyph.up, down: glyph.down, branchGlyph: glyph.branch, ascii });
  const rightWidth = displayWidth(parts.right);
  useInput(input => {
    if (mouse === false) return;
    const origin = absoluteOrigin(box.current);
    if (!origin) return;
    for (const event of parseMouse(input)) {
      if (event.kind !== 'press' || event.button !== 'left' || event.shift || event.y !== origin.y) continue;
      if (event.x >= origin.x && event.x < origin.x + Math.min(columns, modeWidth(p.mode))) p.onMode?.();
      if (parts.right.endsWith('? 帮助') && event.x >= origin.x + columns - 6 && event.x < origin.x + columns) p.onHelp?.();
    }
  });
  return (
    <Box ref={box} width={columns} flexShrink={0} height={1} overflow="hidden">
      <Text color={color} inverse bold>
        {` ${m.text} `}
      </Text>
      {hive ? <Text color={theme.accent2} inverse bold>{hive}</Text> : null}
      <Box flexGrow={1} overflow="hidden"><Text color={p.toast ? p.toast.tone === 'error' ? theme.danger : p.toast.tone === 'warn' ? theme.warn : theme.info : theme.muted} wrap="truncate-end"> {p.toast ? truncateDisplay(terminalText(p.toast.text), Math.max(0, columns - displayWidth(base + hive) - rightWidth - 1)) : parts.left}</Text></Box>
      <Box width={rightWidth} flexShrink={0}><Text dimColor wrap="truncate-end">{parts.right}</Text></Box>
    </Box>
  );
}

const AGENT_ICON: Record<AgentInfo['state'], string> = { queued: '◌', running: '◉', waiting: '◎', paused: 'Ⅱ', done: '✓', failed: '✗', cancelled: '⊘' };

/** 蜂群面板：有子 agent 在运行时显示（id · 角色 · 状态 · 当前活动 · 任务） */
export function AgentsPanel({ agents, activity, maxHeight = 11, onOpenDeck }: { agents: AgentInfo[]; activity: (id: string) => string; maxHeight?: number; onOpenDeck?(): void }) {
  const theme = useTheme();
  const { ascii } = useTerminal();
  const { columns } = useViewport(), { mouse } = useTerminal();
  const box = useRef<DOMElement>(null); const metrics = useBoxMetrics(box);
  useInput(input => {
    if (mouse === false || !onOpenDeck) return;
    const origin = absoluteOrigin(box.current);
    if (!origin) return;
    if (parseMouse(input).some(event => event.kind === 'press' && event.button === 'left' && !event.shift && event.x >= origin.x && event.x < origin.x + columns && event.y >= origin.y && event.y < origin.y + metrics.height)) onOpenDeck();
  });
  const children = agents.filter((a) => a.parentId !== null);
  if (maxHeight < 1 || !children.some((a) => ['running', 'queued', 'waiting', 'paused'].includes(a.state))) return null;
  const border = maxHeight >= 4;
  const color = (s: AgentInfo['state']) => (s === 'done' ? theme.success : s === 'failed' ? theme.danger : s === 'cancelled' ? theme.warn : theme.accent);
  return (
    <Box ref={box} flexDirection="column" borderStyle={border ? ascii ? 'classic' : 'round' : undefined} borderColor={theme.border} paddingX={border ? 1 : 0} flexShrink={0}>
      <Text color={theme.accent} bold>
        HIVE {children.filter((a) => ['running', 'queued', 'waiting', 'paused'].includes(a.state)).length}/{children.length} · Ctrl+G 指挥台
      </Text>
      {children.filter((a) => ['running', 'queued', 'waiting', 'paused'].includes(a.state)).slice(0, Math.max(0, maxHeight - 1 - (border ? 2 : 0))).map((a) => (
        <Text key={a.id} wrap="truncate-end">
          {'  '.repeat(Math.max(0, a.depth - 1))}
          <Text color={color(a.state)}>{ascii ? a.state === 'paused' ? '||' : '*' : AGENT_ICON[a.state]}</Text> <Text bold>{a.id}</Text> <Text dimColor>[{a.role}]</Text>{' '}
          <Text color={theme.tool}>{a.waitingFor ?? (a.state === 'running' ? activity(a.id) : a.report ? a.report.status : a.state)}</Text>{' '}
          <Text dimColor>{Math.floor(((a.endedAt ?? Date.now()) - a.startedAt) / 1000)}s</Text>
        </Text>
      ))}
    </Box>
  );
}

const TODO_ICON: Record<TodoItem['status'], string> = { pending: '☐', in_progress: '◐', completed: '☑' };

export function TodoPanel({ todos, maxHeight = 7 }: { todos: TodoItem[]; maxHeight?: number }) {
  const theme = useTheme();
  const { ascii } = useTerminal();
  if (maxHeight < 1 || todos.length === 0 || todos.every((t) => t.status === 'completed')) return null;
  const border = maxHeight >= 4;
  const done = todos.filter((t) => t.status === 'completed').length;
  return (
    <Box flexDirection="column" borderStyle={border ? ascii ? 'classic' : 'round' : undefined} borderColor={theme.border} paddingX={border ? 1 : 0} flexShrink={0}>
      <Text color={theme.accent} bold>
        待办 {done}/{todos.length}
      </Text>
      {[...todos.filter((t) => t.status === 'in_progress'), ...todos.filter((t) => t.status === 'pending')].slice(0, Math.max(0, maxHeight - 1 - (border ? 2 : 0))).map((t, i) => (
        <Text key={i} wrap="truncate-end" color={t.status === 'in_progress' ? theme.accent2 : undefined}>
          {ascii ? t.status === 'in_progress' ? '[~]' : '[ ]' : TODO_ICON[t.status]} {terminalText(t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content)}
        </Text>
      ))}
    </Box>
  );
}

export function TurnSummary({ durationMs, usage, reason }: { durationMs: number; usage: TokenUsage; reason: string }) {
  const theme = useTheme();
  const glyph = useGlyphs();
  const { ascii } = useTerminal();
  const status = reason === 'completed' ? '' : reason === 'aborted' ? ' · 已中断' : reason === 'max-steps' ? ' · 步数上限' : ' · 出错';
  return (
    <Text color={theme.muted}>
      {ascii ? '*' : '✻'} 用时 {(durationMs / 1000).toFixed(1)}s · {glyph.up}{k(usage.input + usage.cacheRead)} {glyph.down}{k(usage.output)}
      {usage.cacheRead > 0 ? ` · 缓存 ${k(usage.cacheRead)}` : ''}
      {status}
    </Text>
  );
}
