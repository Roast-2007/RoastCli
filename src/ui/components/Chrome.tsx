/**
 * 界面"外壳"组件：启动横幅、状态栏（模式胶囊 / 模型 / 上下文量规 / 缓存 / 用量 / 计时）、待办面板、回合小结。
 */
import { Box, Text, useWindowSize } from 'ink';
import type { TokenUsage } from '../../core/types.js';
import type { PermissionMode } from '../../tools/permissions/engine.js';
import type { TodoItem } from '../../tools/interact/index.js';
import type { AgentInfo } from '../../swarm/types.js';
import { gradientChars, useTheme } from '../theme.js';
import { useSpinner } from './useSpinner.js';
import { displayWidth, truncateDisplay } from '../../core/text-width.js';
import { terminalText } from '../../core/terminal-text.js';
import { useTerminal, useGlyphs } from '../terminal.js';

const LOGO = 'R O A S T';

export function Banner({ model, cwd, resumed, warnings }: { model: string; cwd: string; resumed?: string; warnings: string[] }) {
  const theme = useTheme();
  const { ascii } = useTerminal();
  const glyph = useGlyphs();
  const { columns } = useWindowSize();
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        {gradientChars(ascii ? LOGO : `🔥 ${LOGO}`, theme.gradient).map((c, i) => (
          <Text key={i} color={c.color} bold>
            {c.ch}
          </Text>
        ))}
        <Text dimColor>  v0.1 · {truncateDisplay(model, Math.max(0, columns - 23))}</Text>
      </Text>
      <Text dimColor wrap="truncate-middle">{terminalText(cwd)}</Text>
      {resumed ? <Text color={theme.info}>{ascii ? '>' : '↺'} {resumed}</Text> : null}
      {warnings.map((w, i) => (
        <Text key={i} color={theme.warn}>
          {glyph.warning} {terminalText(w)}
        </Text>
      ))}
      <Text dimColor wrap="truncate-end">? 帮助 · / 命令 · @ 文件 · ! shell · # 记忆 · Shift+Tab 模式 · Esc 中断</Text>
    </Box>
  );
}

const MODE: Record<PermissionMode, { text: string; key: keyof ReturnType<typeof useTheme> }> = {
  default: { text: '默认', key: 'muted' },
  acceptEdits: { text: '自动编辑', key: 'success' },
  plan: { text: '计划', key: 'info' },
  yolo: { text: 'YOLO', key: 'danger' },
};

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
}

export function StatusLine(p: StatusLineProps) {
  const theme = useTheme();
  const { columns } = useWindowSize();
  const frame = useSpinner(p.running);
  const glyph = useGlyphs();
  const m = MODE[p.mode];
  const color = theme[m.key] as string | undefined;
  const lastIn = p.last ? p.last.input + p.last.cacheRead : 0;
  const cacheHit = p.last && lastIn > 0 ? Math.round((p.last.cacheRead / lastIn) * 100) : null;
  const base = ` ${m.text} `;
  const separator = ` ${glyph.separator} `;
  const percent = Math.max(0, Math.min(100, Number.isFinite(p.contextPercent) ? Math.round(p.contextPercent) : 0));
  const gaugeWidth = columns >= 100 ? 6 : 0;
  const model = ` ${truncateDisplay(p.model, Math.max(5, Math.floor(columns / 4)))}${separator}ctx `;
  const primary = `${model}${'#'.repeat(gaugeWidth)}${gaugeWidth ? ' ' : ''}${percent}%`;
  const activity = p.running ? `${separator}${frame} ${Math.floor(p.elapsedMs / 1000)}s · step ${p.step}` : `${separator}? 帮助`;
  const parts = [p.agents ? `${separator}${p.agents} agents` : '', p.cost ? `${separator}${p.cost}` : '', `${separator}${glyph.up}${k(p.total.input + p.total.cacheRead)} ${glyph.down}${k(p.total.output)}`, cacheHit !== null ? `${separator}缓存 ${cacheHit}%` : '', p.branch ? `${separator}${glyph.branch} ${terminalText(p.branch)}` : ''];
  let text = primary;
  for (const part of parts) if (displayWidth(base + text + part + activity) <= columns) text += part;
  return (
    <Box flexShrink={0} height={1} overflow="hidden">
      <Text color={color} inverse bold>
        {` ${m.text} `}
      </Text>
      {p.toast ? <Text color={p.toast.tone === 'error' ? theme.danger : p.toast.tone === 'warn' ? theme.warn : p.toast.tone === 'success' ? theme.success : theme.info} wrap="truncate-end"> {terminalText(p.toast.text)}</Text> : gaugeWidth ? <Text dimColor wrap="truncate-end">{model}<Gauge percent={percent} width={gaugeWidth} />{text.slice(primary.length)}{activity}</Text> : <Text dimColor wrap="truncate-end">{truncateDisplay(text + activity, Math.max(0, columns - displayWidth(base)))}</Text>}
    </Box>
  );
}

const AGENT_ICON: Record<AgentInfo['state'], string> = { queued: '◌', running: '◉', waiting: '◎', paused: 'Ⅱ', done: '✓', failed: '✗', cancelled: '⊘' };

/** 蜂群面板：有子 agent 在运行时显示（id · 角色 · 状态 · 当前活动 · 任务） */
export function AgentsPanel({ agents, activity, maxHeight = 11 }: { agents: AgentInfo[]; activity: (id: string) => string; maxHeight?: number }) {
  const theme = useTheme();
  const { ascii } = useTerminal();
  const children = agents.filter((a) => a.parentId !== null);
  if (maxHeight < 1 || !children.some((a) => ['running', 'queued', 'waiting', 'paused'].includes(a.state))) return null;
  const border = maxHeight >= 4;
  const color = (s: AgentInfo['state']) => (s === 'done' ? theme.success : s === 'failed' ? theme.danger : s === 'cancelled' ? theme.warn : theme.accent);
  return (
    <Box flexDirection="column" borderStyle={border ? ascii ? 'classic' : 'round' : undefined} borderColor={theme.border} paddingX={border ? 1 : 0} flexShrink={0}>
      <Text color={theme.accent} bold>
        Hive · {children.filter((a) => a.state === 'done').length}/{children.length} 完成
      </Text>
      {children.filter((a) => ['running', 'queued', 'waiting', 'paused'].includes(a.state)).slice(0, Math.max(0, maxHeight - 1 - (border ? 2 : 0))).map((a) => (
        <Text key={a.id} wrap="truncate-end">
          {'  '.repeat(Math.max(0, a.depth - 1))}
          <Text color={color(a.state)}>{ascii ? a.state === 'paused' ? '||' : '*' : AGENT_ICON[a.state]}</Text> <Text bold>{a.id}</Text> <Text dimColor>[{a.role}]</Text>{' '}
          <Text color={theme.tool}>{a.waitingFor ?? (a.state === 'running' ? activity(a.id) : a.report ? a.report.status : a.state)}</Text>{' '}
          <Text dimColor>{a.brief.replace(/\s+/g, ' ').slice(0, 40)}</Text>
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
