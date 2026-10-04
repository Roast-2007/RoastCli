/**
 * 上下文状态（折叠进 history reducer）：
 * - elided：被折叠的 tool-result（按 callId），视图里替换为存根，原文仍在历史中，可 recall
 * - compaction：最近一次压缩 —— 视图用摘要替换 messages[0, upTo)
 * 这些都是日志里的决策事件（context/transform、context/compact），回放不重算策略。
 */
import type { SessionEvent } from '../session/events.js';

export interface Elision {
  /** 折叠原因（dedup / aging / manual） */
  reason: string;
  /** 可选预览（老化折叠保留头尾若干行） */
  preview?: string;
  tokens?: number;
}

export interface Compaction {
  /** 被摘要覆盖的消息数（messages[0, upTo)） */
  upTo: number;
  summary: string;
  seq: number;
}

export interface ContextState {
  readonly elided: Readonly<Record<string, Elision>>;
  readonly compaction: Compaction | null;
  /** 用户钉住的 tool-result：策略不会自动折叠（/context pin） */
  readonly pinned?: Readonly<Record<string, true>>;
}

export function initialContext(): ContextState {
  return { elided: {}, compaction: null };
}

export type ElideOp =
  | { op: 'elide'; ids: string[]; reason: string; previews?: Record<string, string>; tokens?: Record<string, number> }
  | { op: 'unelide'; ids: string[] }
  /** 钉住：同时取消折叠；取消钉住只是允许策略再次折叠 */
  | { op: 'pin'; ids: string[] }
  | { op: 'unpin'; ids: string[] };

const without = <T>(rec: Readonly<Record<string, T>>, ids: string[]): Record<string, T> => Object.fromEntries(Object.entries(rec).filter(([id]) => !ids.includes(id)));

function applyOp(ctx: ContextState, op: ElideOp): ContextState {
  switch (op.op) {
    case 'elide': {
      const added = Object.fromEntries(
        op.ids.map((id) => [
          id,
          {
            reason: op.reason,
            ...(op.previews?.[id] !== undefined ? { preview: op.previews[id] } : {}),
            ...(op.tokens?.[id] !== undefined ? { tokens: op.tokens[id] } : {}),
          },
        ]),
      );
      return { ...ctx, elided: { ...ctx.elided, ...added } };
    }
    case 'unelide':
      return { ...ctx, elided: without(ctx.elided, op.ids) };
    case 'pin':
      return { ...ctx, elided: without(ctx.elided, op.ids), pinned: { ...ctx.pinned, ...Object.fromEntries(op.ids.map((id) => [id, true as const])) } };
    case 'unpin':
      return { ...ctx, pinned: without(ctx.pinned ?? {}, op.ids) };
  }
}

/** 处理上下文类事件；messagesLength 用于 rewind 后判断压缩是否仍然有效 */
export function applyContextEvent(ctx: ContextState, ev: SessionEvent, messagesLength: number): ContextState {
  switch (ev.type) {
    case 'context/transform':
      return ev.ops.reduce(applyOp, ctx);
    case 'context/compact':
      return { ...ctx, compaction: { upTo: ev.upTo, summary: ev.summary, seq: ev.seq ?? 0 } };
    case 'rewind':
      // 回退到压缩点之前：摘要覆盖的范围已不存在，压缩失效
      return ctx.compaction && ctx.compaction.upTo > messagesLength ? { ...ctx, compaction: null } : ctx;
    default:
      return ctx;
  }
}
