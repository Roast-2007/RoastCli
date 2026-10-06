/**
 * UI store：按 agentId 分片的 AgentView 集合 + 合批刷新（默认 ~30Hz），供 useSyncExternalStore 订阅。
 * 运行时事件经 pushEvent 进入缓冲，按帧批量归约；用户动作（提交消息、提示）立即生效。
 */
import type { UiEvent } from '../../agent/ui-events.js';
import { applyEvent, emptyAgentView, pushItems, replayView, groupNewTools, type AgentView, type Tone } from './reducer.js';
import type { SessionEvent } from '../../session/events.js';
import type { InteractionRequest } from '../../core/interaction.js';
import type { PermissionMode } from '../../tools/permissions/engine.js';
import type { AgentInfo, Envelope } from '../../swarm/types.js';

/** 与具体 agent 无关的界面状态（控制器写入，inline 与 Mission Control 共用） */
export type OverlayKind = 'help' | 'rewind' | 'context' | 'sessions' | 'theme' | 'mode' | 'model' | 'hive-models' | 'swarm' | 'strategy' | 'skills' | 'board' | 'cost' | 'todo' | 'mcp' | 'logs' | 'memory' | 'compact' | 'init' | 'agents';
export interface UiMeta {
  interactions: InteractionRequest[];
  mode: PermissionMode;
  contextPercent: number;
  swarm: AgentInfo[];
  /** 消息总线时间线（最近若干条） */
  messages: Envelope[];
  /** 输入框重置种子（中断后放回的排队插话） */
  inputSeed: { key: number; text: string; screen?: 'inline' | 'hive' | 'providers' };
  queued: string[];
  running: boolean;
  screen: 'inline' | 'hive' | 'providers';
  strategy?: string;
  n?: number;
  overlay: OverlayKind | null;
  theme?: string;
  toast?: { text: string; tone: Tone } | null;
}

export interface UiStoreState {
  agents: Readonly<Record<string, AgentView>>;
  focus: string;
  meta: UiMeta;
}

export function defaultMeta(): UiMeta {
  return { interactions: [], mode: 'default', contextPercent: 0, swarm: [], messages: [], inputSeed: { key: 0, text: '' }, queued: [], running: false, screen: 'inline', overlay: null };
}

export interface UiStore {
  getState(): UiStoreState;
  subscribe(listener: () => void): () => void;
  pushEvent(agentId: string, ev: UiEvent): void;
  addUser(agentId: string, text: string): void;
  addNotice(agentId: string, text: string, tone?: Tone, quiet?: boolean): void;
  setMeta(patch: Partial<UiMeta> | ((m: UiMeta) => Partial<UiMeta>)): void;
  setFocus(agentId: string): void;
  /** 立即应用缓冲中的事件 */
  flush(): void;
  restore(agentId: string, events: readonly SessionEvent[]): void;
}

export interface UiStoreOptions {
  frameMs?: number;
  now?: () => number;
}

export function createUiStore(opts: UiStoreOptions = {}): UiStore {
  const frameMs = opts.frameMs ?? 33;
  const now = opts.now ?? Date.now;
  let state: UiStoreState = { agents: { main: emptyAgentView() }, focus: 'main', meta: defaultMeta() };
  const listeners = new Set<() => void>();
  let buffer: { agentId: string; ev: UiEvent }[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const emit = () => {
    for (const l of listeners) l();
  };
  const update = (agentId: string, fn: (v: AgentView) => AgentView) => {
    const current = state.agents[agentId] ?? emptyAgentView();
    state = { ...state, agents: { ...state.agents, [agentId]: fn(current) } };
  };
  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    const t = now();
    const groups = new Map<string, UiEvent[]>();
    for (const { agentId, ev } of batch) {
      const events = groups.get(agentId) ?? [];
      const previous = events.at(-1);
      if (ev.type === 'text-delta' && previous?.type === 'text-delta') previous.text += ev.text;
      else if (ev.type === 'reasoning-delta' && previous?.type === 'reasoning-delta') previous.text += ev.text;
      else events.push({ ...ev });
      groups.set(agentId, events);
    }
    for (const [agentId, events] of groups) update(agentId, (v) => groupNewTools(events.reduce((view, ev) => applyEvent(view, ev, t), v), v.items.length));
    emit();
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    pushEvent(agentId, ev) {
      buffer.push({ agentId, ev });
      // 当前关注的 agent 的回合边界立即刷新（提示与小结不延迟）；子 agent 一律按帧合批，避免蜂群同时起止时的渲染风暴
      if ((ev.type === 'turn-end' || ev.type === 'turn-start') && agentId === state.focus) return flush();
      timer ??= setTimeout(flush, frameMs);
    },
    addUser(agentId, text) {
      flush();
      update(agentId, (v) => pushItems(v, { kind: 'user', text }));
      emit();
    },
    addNotice(agentId, text, tone = 'info', quiet = false) {
      flush();
      update(agentId, (v) => pushItems(v, { kind: 'notice', text, tone, quiet }));
      emit();
    },
    setMeta(patch) {
      const p = typeof patch === 'function' ? patch(state.meta) : patch;
      if (Object.entries(p).every(([key, value]) => state.meta[key as keyof UiMeta] === value)) return;
      state = { ...state, meta: { ...state.meta, ...p } };
      emit();
    },
    setFocus(agentId) {
      if (state.focus === agentId) return;
      state = { ...state, focus: agentId };
      emit();
    },
    flush,
    restore(agentId, events) {
      update(agentId, () => replayView(events));
      emit();
    },
  };
}
