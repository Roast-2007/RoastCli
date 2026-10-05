/**
 * Hive 蜂群的核心类型：角色、状态、消息信封、报告、agent 信息。
 */

export type AgentRole = 'queen' | 'lead' | 'worker' | 'scout' | 'critic' | 'judge';
export type AgentState = 'queued' | 'running' | 'waiting' | 'paused' | 'done' | 'failed' | 'cancelled';
export type EnvelopeKind = 'task' | 'report' | 'question' | 'answer' | 'info' | 'alert' | 'steer';

export type Address =
  | { agent: string }
  | { rel: 'parent' | 'children' | 'siblings' }
  | { role: AgentRole }
  | { topic: string }
  | 'broadcast';

export interface Envelope {
  id: string;
  from: string;
  to: Address;
  kind: EnvelopeKind;
  subject: string;
  body: string;
  /** 大块内容用引用传递（黑板键 / ctx 句柄 / 文件路径），不塞进正文 */
  refs: string[];
  replyTo?: string;
  hop: number;
  at: number;
}

export interface Report {
  agentId: string;
  status: 'done' | 'failed' | 'partial' | 'changes_requested' | 'cancelled';
  summary: string;
  refs: string[];
}

export interface AgentInfo {
  id: string;
  parentId: string | null;
  role: AgentRole;
  depth: number;
  state: AgentState;
  /** A pending user interaction, visible to Queen and both TUI screens. */
  waitingFor?: string;
  brief: string;
  model: string;
  reasoningEffort?: import('../core/config.js').ReasoningEffort | null;
  startedAt: number;
  endedAt?: number;
  report?: Report;
  children: string[];
  /** 使用独立 git worktree 时的根目录（合并后清除） */
  worktree?: string;
}

/** 只有这些消息会唤醒处于等待中的 agent；info 等到下一次自然边界再送达 */
export const WAKE_KINDS: ReadonlySet<EnvelopeKind> = new Set(['question', 'answer', 'steer', 'alert', 'report']);

/** 只读角色：不能修改文件或执行有副作用的命令 */
export const READ_ONLY_ROLES: ReadonlySet<AgentRole> = new Set(['scout', 'critic', 'judge']);

export function parseAddress(text: string): Address {
  const t = text.trim();
  if (t === 'parent' || t === 'children' || t === 'siblings') return { rel: t };
  if (t === 'broadcast') return 'broadcast';
  if (t.startsWith('role:')) return { role: t.slice(5) as AgentRole };
  if (t.startsWith('topic:')) return { topic: t.slice(6) };
  return { agent: t };
}

export function formatAddress(a: Address): string {
  if (a === 'broadcast') return 'broadcast';
  if ('agent' in a) return a.agent;
  if ('rel' in a) return a.rel;
  if ('role' in a) return `role:${a.role}`;
  return `topic:${a.topic}`;
}
