/**
 * 历史 reducer：SessionEvent 流 → 模型可见的 Message[]。
 * 运行时（Committer）与 resume/投影共用这一个纯函数，保证"实时 == 回放"。
 *
 * 规则（v1）：
 * - user/message：若末尾是 user 消息则合并内容（插话 steer、上一轮无回复等场景，
 *   避免连续 user 消息），否则新起一条
 * - assistant/message：追加
 * - tool/result：同一 (turn, step) 的结果合并进同一条 user 消息，按到达顺序
 * - attachment/injected：追加到末尾 user 消息（位于 tool_result 之后），否则新起一条
 * - history/import：整体替换（resume 旧格式日志）
 * - turn/start 记下该 turn 开始前的消息；rewind{toTurn} 把消息恢复到那一刻（之后的 turn 记录作废）
 */
import { createHash } from 'node:crypto';
import type { ContentBlock, Message, ToolResultBlock } from '../core/types.js';
import type { SessionEvent } from './events.js';
import { applyContextEvent, initialContext, type ContextState } from '../context/state.js';

export interface HistoryState {
  readonly messages: readonly Message[];
  /** 最近一个 tool/result 的 "turn:step"，用于合并同 step 结果 */
  readonly toolKey: string | null;
  readonly turn: number;
  readonly lastSeq: number;
  readonly missionSeq?: number;
  readonly budgetMarks?: readonly string[];
  /** 每个 turn 开始前的消息快照（不可变引用，开销很小），rewind 用 */
  readonly turnStarts: Readonly<Record<number, readonly Message[]>>;
  /** 上下文变换（折叠 / 压缩），视图投影见 context/view.ts */
  readonly context: ContextState;
}

export function initialHistory(): HistoryState {
  return { messages: [], toolKey: null, turn: 0, lastSeq: 0, turnStarts: {}, context: initialContext() };
}

export interface PackedTurnStarts {
  pool: Message[];
  turns: Record<number, number[]>;
}

/** 各 turn 的快照共享同一批消息对象：按引用去重后只存下标，日志体积随消息数线性增长 */
export function packTurnStarts(starts: HistoryState['turnStarts']): PackedTurnStarts {
  const pool: Message[] = [],
    index = new Map<Message, number>(),
    turns: Record<number, number[]> = {};
  for (const [turn, messages] of Object.entries(starts)) {
    turns[Number(turn)] = messages.map((message) => {
      let at = index.get(message);
      if (at === undefined) {
        at = pool.length;
        pool.push(message);
        index.set(message, at);
      }
      return at;
    });
  }
  return { pool, turns };
}

/** 下标越界的 turn 视为损坏，直接丢弃（只是不能回退到该轮） */
export function unpackTurnStarts(packed: PackedTurnStarts): HistoryState['turnStarts'] {
  const starts: Record<number, readonly Message[]> = {};
  for (const [turn, indexes] of Object.entries(packed.turns)) {
    if (indexes.every((at) => Number.isInteger(at) && at >= 0 && at < packed.pool.length))
      starts[Number(turn)] = indexes.map((at) => packed.pool[at]!);
  }
  return starts;
}

function appendToTrailingUser(messages: readonly Message[], blocks: ContentBlock[]): readonly Message[] {
  const last = messages[messages.length - 1];
  if (last && last.role === 'user') {
    return [...messages.slice(0, -1), { role: 'user', content: [...last.content, ...blocks] }];
  }
  return [...messages, { role: 'user', content: blocks }];
}

function toolResultBlock(ev: Extract<SessionEvent, { type: 'tool/result' }>): ToolResultBlock {
  return {
    type: 'tool-result',
    toolCallId: ev.callId,
    name: ev.name,
    content: ev.content,
    ...(ev.isError ? { isError: true } : {}),
  };
}

export function applyHistory(state: HistoryState, ev: SessionEvent): HistoryState {
  const next = applyMessages(state, ev);
  const context = applyContextEvent(next.context, ev, next.messages.length);
  return context === next.context ? next : { ...next, context };
}

function applyMessages(state: HistoryState, ev: SessionEvent): HistoryState {
  const lastSeq = ev.seq ?? state.lastSeq;
  switch (ev.type) {
    case 'turn/start':
      return { ...state, turn: ev.turn, lastSeq, turnStarts: { ...state.turnStarts, [ev.turn]: state.messages } };
    case 'rewind': {
      const target = state.turnStarts[ev.toTurn];
      if (!target) return { ...state, lastSeq };
      const turnStarts = Object.fromEntries(Object.entries(state.turnStarts).filter(([t]) => Number(t) < ev.toTurn));
      return { ...state, messages: target, toolKey: null, lastSeq, turnStarts };
    }
    case 'hive/mission':
    case 'user/message': {
      const message: Message =
        ev.type === 'hive/mission' ? { role: 'user', content: [{ type: 'text', text: ev.brief }, ...(ev.images ?? [])] } : ev.message;
      const last = state.messages[state.messages.length - 1];
      const messages = last?.role === 'user' ? appendToTrailingUser(state.messages, message.content) : [...state.messages, message];
      return {
        ...state,
        messages,
        toolKey: null,
        lastSeq,
        ...(ev.type === 'hive/mission' ? { missionSeq: Math.max(state.missionSeq ?? 0, Number(ev.missionId.slice(1)) || 0) } : {}),
      };
    }
    case 'assistant/message':
      return { ...state, messages: [...state.messages, ev.message], toolKey: null, lastSeq };
    case 'tool/result': {
      const key = `${ev.turn}:${ev.step}`;
      const block = toolResultBlock(ev);
      const last = state.messages[state.messages.length - 1];
      const messages =
        state.toolKey === key && last?.role === 'user'
          ? appendToTrailingUser(state.messages, [block])
          : [...state.messages, { role: 'user' as const, content: [block] }];
      return { ...state, messages, toolKey: key, lastSeq };
    }
    case 'attachment/injected':
      return {
        ...state,
        messages: appendToTrailingUser(state.messages, ev.blocks),
        lastSeq,
        ...(ev.source === 'budget' ? { budgetMarks: [...(state.budgetMarks ?? []), `${ev.turn}:${ev.step}`] } : {}),
      };
    case 'history/import':
      return {
        ...state,
        messages: ev.messages,
        toolKey: null,
        lastSeq,
        ...(ev.turn !== undefined ? { turn: ev.turn } : {}),
        ...(ev.turnStarts ? { turnStarts: unpackTurnStarts(ev.turnStarts) } : {}),
        ...(ev.missionSeq !== undefined ? { missionSeq: ev.missionSeq } : {}),
      };
    default:
      return state.lastSeq === lastSeq ? state : { ...state, lastSeq };
  }
}

export function foldHistory(events: readonly SessionEvent[], from: HistoryState = initialHistory()): HistoryState {
  return events.reduce(applyHistory, from);
}

/** 稳定序列化：对象键排序、丢弃 undefined（与 JSON 往返结果一致） */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : stableStringify(v))).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

export function hashOf(value: unknown): string {
  return createHash('sha1').update(stableStringify(value)).digest('hex').slice(0, 16);
}

export function hashMessages(messages: readonly Message[]): string {
  return hashOf(messages);
}
