import type { Target } from './hitmap.js';
/**
 * Hive 的紧凑行渲染（纯函数）：把 AgentView 转成定高窗格里的一行行文本，
 * 便于精确控制高度（全屏布局不能依赖自动换行）。
 */
import type { AgentView, DisplayItem } from '../store/reducer.js';
import { argSummary } from '../components/ToolCard.js';
import type { AgentInfo, Envelope } from '../../swarm/types.js';
import { formatAddress } from '../../swarm/types.js';

export type LineTone = 'user' | 'text' | 'tool' | 'ok' | 'error' | 'warn' | 'muted' | 'accent';

export interface Line {
  text: string;
  target?: Target;
  tone: LineTone;
}

function itemLines(item: DisplayItem, ascii = false): Line[] {
  switch (item.kind) {
    case 'mission': return [{ text: `${ascii ? '*' : '⬡'} 任务 #${item.missionId.slice(1)} · ${item.strategy} · ${item.goal}`, tone: 'user' }];
    case 'user':
      return [{ text: `${ascii ? '>' : '›'} ${item.text.split('\n')[0]}`, tone: 'user' }];
    case 'markdown':
      return item.text.split('\n').filter((l) => l.trim()).map((l) => ({ text: l, tone: 'text' as const }));
    case 'reasoning':
      return [{ text: `${ascii ? '...' : '💭'} ${item.text.replace(/\s+/g, ' ').slice(0, 120)}`, tone: 'muted' }];
    case 'tool': {
      const t = item.tool;
      const icon = t.status === 'done' ? ascii ? '+' : '✓' : t.status === 'error' ? ascii ? 'x' : '✗' : t.status === 'interrupted' ? ascii ? '-' : '⊘' : ascii ? '.' : '◌';
      return [{ text: `${icon} ${t.name} ${argSummary(t.name, t.args)}`, tone: t.status === 'error' ? 'error' : t.status === 'done' ? 'ok' : 'warn' }];
    }
    case 'tool-group':
      return item.tools.map((tool) => ({ text: `${ascii ? '+' : '✓'} ${tool.name} ${argSummary(tool.name, tool.args)}`, tone: 'ok' as const }));
    case 'notice':
      return item.quiet ? [] : [{ text: `${ascii ? '*' : '•'} ${item.text.split('\n')[0]}`, tone: item.tone === 'error' ? 'error' : item.tone === 'warn' ? 'warn' : 'muted' }];
    case 'turn-summary':
      return [{ text: `${ascii ? '*' : '✻'} ${(item.durationMs / 1000).toFixed(1)}s · ${item.reason}`, tone: 'muted' }];
  }
}

/** 某个 agent 的全部行（定稿条目 + 流式尾巴 + 运行中工具），调用方取最后 N 行显示 */
export function agentLines(view: AgentView | undefined, ascii = false): Line[] {
  if (!view) return [{ text: '（还没有输出）', tone: 'muted' }];
  const lines = view.items.flatMap((item) => itemLines(item, ascii));
  if (view.reasoning) lines.push({ text: `${ascii ? '...' : '💭'} 思考中… ${view.reasoning.length} 字`, tone: 'muted' });
  if (view.pending) lines.push(...view.pending.split('\n').filter((l) => l.trim()).map((l) => ({ text: l, tone: 'text' as const })));
  for (const t of view.tools) {
    lines.push({ text: `${ascii ? '.' : '◌'} ${t.name} ${argSummary(t.name, t.args)}`, tone: 'accent' });
    if (t.live) lines.push(...t.live.split('\n').filter(Boolean).slice(-3).map((l) => ({ text: `  ${l}`, tone: 'muted' as const })));
  }
  return lines.length ? lines : [{ text: '（还没有输出）', tone: 'muted' }];
}

/** agent 树：深度优先，root 在前 */
export function treeOrder(agents: AgentInfo[]): AgentInfo[] {
  const byParent = new Map<string | null, AgentInfo[]>();
  for (const a of agents) byParent.set(a.parentId, [...(byParent.get(a.parentId) ?? []), a]);
  const out: AgentInfo[] = [];
  const walk = (parent: string | null) => {
    for (const a of byParent.get(parent) ?? []) {
      out.push(a);
      walk(a.id);
    }
  };
  walk(null);
  for (const a of agents) if (a.parentId && !agents.some((parent) => parent.id === a.parentId)) { out.push(a); walk(a.id); }
  return out;
}

export function messageLine(e: Envelope, ascii = false): Line {
  const tone: LineTone = e.kind === 'alert' ? 'error' : e.kind === 'question' ? 'warn' : e.kind === 'report' ? 'ok' : e.kind === 'steer' ? 'accent' : 'muted';
  return { text: `${e.from}${ascii ? '->' : '→'}${formatAddress(e.to)} [${e.kind}] ${e.subject}`, tone };
}

/**
 * 可滚动窗口：offset 为距底部的行数（0 = 跟随最新输出）。
 * 返回实际可见的行与修正后的 offset（不会滚出顶部）。
 */
export function windowLines(lines: Line[], height: number, offset: number): { shown: Line[]; offset: number } {
  const h = Math.max(0, height);
  const maxOffset = Math.max(0, lines.length - h);
  const o = Math.min(Math.max(0, offset), maxOffset);
  return { shown: lines.slice(Math.max(0, lines.length - h - o), lines.length - o), offset: o };
}
