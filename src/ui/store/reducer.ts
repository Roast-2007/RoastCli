/**
 * UI 状态归约（纯函数，按 agent 分片）。
 * - items：已定稿的显示条目（进入 <Static>，只渲染一次）：用户消息、markdown 块、思考摘要、工具卡片、提示、回合小结
 * - 活动区：pending（流式文本尾巴）、reasoning、运行中的工具
 * 流式文本每到一段就用 splitStreaming 把已完成的 markdown 块提交为条目，活动区只剩尾巴。
 */
import type { UiEvent } from '../../agent/ui-events.js';
import { addUsage, emptyUsage, type TokenUsage } from '../../core/types.js';
import type { TodoItem } from '../../tools/interact/index.js';
import { splitStreaming } from '../markdown/split.js';
import type { SessionEvent } from '../../session/events.js';

export interface ToolView {
  callId: string;
  name: string;
  args: unknown;
  status: 'running' | 'done' | 'error' | 'interrupted';
  preview: string;
  /** 结果全文（截断），Ctrl+O 查看 */
  output?: string;
  durationMs: number;
  live?: string;
  metadata?: Record<string, unknown>;
}

export type Tone = 'info' | 'warn' | 'error' | 'success';

export type DisplayItem =
  | { id: number; kind: 'mission'; missionId: string; goal: string; strategy: string; n: number; turn: number; startedAt?: number }
  | { id: number; kind: 'user'; text: string }
  | { id: number; kind: 'markdown'; text: string }
  | { id: number; kind: 'reasoning'; text: string }
  | { id: number; kind: 'tool'; tool: ToolView }
  | { id: number; kind: 'tool-group'; tools: ToolView[] }
  | { id: number; kind: 'notice'; text: string; tone: Tone; quiet?: boolean }
  | { id: number; kind: 'turn-summary'; durationMs: number; usage: TokenUsage; reason: string };

export interface AgentView {
  items: DisplayItem[];
  pending: string;
  reasoning: string;
  tools: ToolView[];
  running: boolean;
  turnStartedAt: number | null;
  turnUsage: TokenUsage;
  totalUsage: TokenUsage;
  lastUsage: TokenUsage | null;
  step: number;
  todos: TodoItem[];
  nextId: number;
}

export function emptyAgentView(): AgentView {
  return {
    items: [],
    pending: '',
    reasoning: '',
    tools: [],
    running: false,
    turnStartedAt: null,
    turnUsage: emptyUsage(),
    totalUsage: emptyUsage(),
    lastUsage: null,
    step: 0,
    todos: [],
    nextId: 1,
  };
}

type NewItem = DisplayItem extends infer T ? (T extends DisplayItem ? Omit<T, 'id'> : never) : never;

export function pushItems(v: AgentView, ...items: NewItem[]): AgentView {
  if (items.length === 0) return v;
  const withIds = items.map((it, i) => ({ ...it, id: v.nextId + i }) as DisplayItem);
  return { ...v, items: [...v.items, ...withIds], nextId: v.nextId + items.length };
}

/** Never modifies already published items: Ink Static uses their ids as its watermark. */
export function groupNewTools(view: AgentView, start: number): AgentView {
  const fresh = view.items.slice(start);
  const output: DisplayItem[] = [];
  let grouped = false;
  for (let i = 0; i < fresh.length;) {
    const item = fresh[i]!;
    const safe = (candidate: DisplayItem) => candidate.kind === 'tool' && candidate.tool.status === 'done' && ['read', 'grep', 'glob', 'ls', 'search_code'].includes(candidate.tool.name) && !candidate.tool.metadata?.['diff'];
    if (!safe(item) || item.kind !== 'tool') { output.push(item); i++; continue; }
    const tools: ToolView[] = [item.tool];
    let end = i + 1;
    while (end < fresh.length) {
      const next = fresh[end]!;
      if (!safe(next) || next.kind !== 'tool' || next.tool.name !== item.tool.name) break;
      tools.push(next.tool); end++;
    }
    if (tools.length >= 3) { output.push({ kind: 'tool-group', id: fresh[end - 1]!.id, tools }); grouped = true; }
    else output.push(...fresh.slice(i, end));
    i = end;
  }
  return grouped ? { ...view, items: [...view.items.slice(0, start), ...output] } : view;
}

/** 把活动区的流式文本与思考全部定稿 */
function flushStream(v: AgentView): AgentView {
  const items: NewItem[] = [];
  if (v.reasoning.trim()) items.push({ kind: 'reasoning', text: v.reasoning.trim() });
  if (v.pending.trim()) items.push({ kind: 'markdown', text: v.pending.trim() });
  return { ...pushItems(v, ...items), pending: '', reasoning: '' };
}

function appendText(v: AgentView, text: string): AgentView {
  // 正文开始时思考已结束：先定稿思考
  const base = v.reasoning.trim() ? { ...pushItems(v, { kind: 'reasoning', text: v.reasoning.trim() }), reasoning: '' } : v;
  const { complete, rest } = splitStreaming(base.pending + text);
  return { ...pushItems(base, ...complete.map((t) => ({ kind: 'markdown' as const, text: t }))), pending: rest };
}

export function applyEvent(v: AgentView, ev: UiEvent, now: number): AgentView {
  switch (ev.type) {
    case 'hive/mission': return pushItems(flushStream(v), { kind: 'mission', missionId: ev.missionId, goal: ev.goal, strategy: ev.strategy, n: ev.n, turn: ev.turn, startedAt: Date.parse(ev.at) || now });
    case 'turn-start':
      return { ...v, running: true, turnStartedAt: now, turnUsage: emptyUsage(), step: 0, tools: [] };
    case 'text-delta':
      return appendText(v, ev.text);
    case 'reasoning-delta':
      return { ...v, reasoning: v.reasoning + ev.text };
    case 'stream-reset':
      return { ...v, pending: '', reasoning: '' };
    case 'tool-call-start': {
      const flushed = flushStream(v);
      return { ...flushed, tools: [...flushed.tools, { callId: ev.callId, name: ev.name, args: ev.args, status: 'running', preview: '', durationMs: 0 }] };
    }
    case 'tool-progress':
      return { ...v, tools: v.tools.map((t) => (t.callId === ev.callId ? { ...t, live: tail((t.live ?? '') + ev.text) } : t)) };
    case 'tool-call-end': {
      const started = v.tools.find((t) => t.callId === ev.callId);
      const done: ToolView = {
        callId: ev.callId,
        name: ev.name,
        args: started?.args,
        status: ev.isError ? 'error' : 'done',
        preview: ev.preview,
        ...(ev.output !== undefined ? { output: ev.output } : {}),
        durationMs: ev.durationMs,
        ...(ev.metadata ? { metadata: ev.metadata } : {}),
      };
      const todos = ev.name === 'todo_write' && Array.isArray(ev.metadata?.['todos']) ? (ev.metadata['todos'] as TodoItem[]) : v.todos;
      return { ...pushItems(v, { kind: 'tool', tool: done }), tools: v.tools.filter((t) => t.callId !== ev.callId), todos };
    }
    case 'usage':
      return { ...v, turnUsage: addUsage(v.turnUsage, ev.usage), totalUsage: addUsage(v.totalUsage, ev.usage), lastUsage: ev.usage, step: v.step + 1 };
    case 'turn-end': {
      const flushed = flushStream(v);
      const leftover = flushed.tools.map((t) => ({ kind: 'tool' as const, tool: { ...t, output: t.output ?? t.live, status: 'interrupted' as const } }));
      const notes: NewItem[] = ev.reason === 'aborted' ? [{ kind: 'notice', text: '已中断', tone: 'warn' }] : [];
      const summary: NewItem = { kind: 'turn-summary', durationMs: v.turnStartedAt === null ? 0 : now - v.turnStartedAt, usage: v.turnUsage, reason: ev.reason };
      return { ...pushItems(flushed, ...leftover, ...notes, summary), tools: [], running: false, turnStartedAt: null };
    }
    case 'error':
      return ev.error.code === 'ABORTED' ? v : pushItems(flushStream(v), { kind: 'notice', text: `[${ev.error.code}] ${ev.error.message}`, tone: 'error' });
    case 'notice':
      return pushItems(v, { kind: 'notice', text: ev.text, tone: 'info' });
    case 'retry':
      return pushItems(v, { kind: 'notice', text: `重试 #${ev.attempt}（${ev.code}），${Math.round(ev.delayMs / 100) / 10}s 后再试`, tone: 'warn' });
    case 'waiting':
      return pushItems(v, { kind: 'notice', text: `等待：${ev.reason}`, tone: 'info' });
    case 'user-injected':
      return pushItems(flushStream(v), { kind: 'user', text: ev.text });
    case 'queue-restored':
      return v;
  }
}

const LIVE_TAIL = 2000;
function tail(s: string): string {
  return s.length > LIVE_TAIL ? s.slice(-LIVE_TAIL) : s;
}

/** Replay only committed UI content; raw chunks and internal injected attachments stay out. */
export function replayView(events: readonly SessionEvent[]): AgentView {
  let view = emptyAgentView();
  const turns = new Map<number, AgentView>();
  for (const event of events) {
    const at = 'at' in event ? Date.parse(event.at) || 0 : 0;
    switch (event.type) {
      case 'turn/start': turns.set(event.turn, view); view = applyEvent(view, { type: 'turn-start', turn: event.turn }, at); break;
      case 'user/message': view = pushItems(flushStream(view), { kind: 'user', text: event.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') }); break;
      case 'hive/mission': view = applyEvent(view, event, at); break;
      case 'assistant/message':
        for (const block of event.message.content) {
          if (block.type === 'text') view = applyEvent(view, { type: 'text-delta', text: block.text }, at);
          if (block.type === 'reasoning') view = applyEvent(view, { type: 'reasoning-delta', text: block.text }, at);
        }
        break;
      case 'tool/call': view = applyEvent(view, { type: 'tool-call-start', callId: event.callId, name: event.name, args: event.args }, at); break;
      case 'tool/result': {
        const output = event.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        view = applyEvent(view, { type: 'tool-call-end', callId: event.callId, name: event.name, isError: event.isError, preview: output.slice(0, 800), output: output.slice(0, 8000), durationMs: event.durationMs, metadata: event.metadata }, at);
        break;
      }
      case 'usage': view = applyEvent(view, { type: 'usage', usage: event.usage }, at); break;
      case 'turn/end': view = applyEvent(view, { type: 'turn-end', reason: event.reason, usage: view.turnUsage }, at); break;
      case 'rewind': {
        const before = turns.get(event.toTurn);
        if (before) view = { ...before, nextId: view.nextId, totalUsage: view.totalUsage, lastUsage: view.lastUsage };
        for (const turn of turns.keys()) if (turn >= event.toTurn) turns.delete(turn);
        break;
      }
      case 'history/import':
        view = emptyAgentView();
        for (const message of event.messages) for (const block of message.content) if (block.type === 'text') view = pushItems(view, { kind: message.role === 'user' ? 'user' : 'markdown', text: block.text });
        break;
    }
  }
  view = flushStream(view);
  if (view.tools.length) view = applyEvent(view, { type: 'turn-end', reason: 'aborted', usage: view.turnUsage }, 0);
  return { ...view, running: false, turnStartedAt: null };
}
