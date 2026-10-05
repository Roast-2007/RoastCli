/**
 * 上下文策略（纯函数）：根据历史状态给出候选变换，由 controller（CachePlanner）决定何时应用。
 * - dedup：同一文件之后被再次读取或成功修改 → 折叠更早的 read 结果
 * - aging：超过 agingTurns 个 turn 之前、且大于 agingMinTokens 的工具结果 → 折叠并保留头尾预览
 * - chooseCut：压缩切点（保留最近 keepTurns 个 turn；切点总在 user 文本消息处，保证配对完整）
 */
import type { Message, ToolCallBlock, ToolResultBlock } from '../core/types.js';
import type { HistoryState } from '../session/history.js';
import { estimateBlock } from './estimator.js';

export interface ContextConfig {
  /** 估算占用超过窗口的该比例时压缩 */
  compactAt: number;
  /** 占用超过该比例时才主动应用折叠（否则攒着，保护前缀缓存） */
  elideAt: number;
  /** 一次折叠至少节省这么多 tokens 才值得打穿缓存 */
  minSavings: number;
  keepTurns: number;
  agingTurns: number;
  agingMinTokens: number;
  previewLines: number;
  /** provider 前缀缓存的存活时间；空闲超过它时缓存已冷，可以免费折叠 */
  cacheTtlMs: number;
}

export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  compactAt: 0.8,
  elideAt: 0.7,
  minSavings: 4000,
  keepTurns: 3,
  agingTurns: 8,
  agingMinTokens: 2000,
  previewLines: 20,
  cacheTtlMs: 5 * 60_000,
};

const PATH_TOOLS = new Set(['read', 'edit', 'multi_edit', 'write']);
const WRITE_TOOLS = new Set(['edit', 'multi_edit', 'write']);

interface ResultInfo {
  callId: string;
  name: string;
  path?: string;
  isError: boolean;
  msgIndex: number;
  block: ToolResultBlock;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').toLowerCase();
}

/** 按出现顺序列出所有工具结果，附带调用参数中的路径 */
export function toolResults(messages: readonly Message[]): ResultInfo[] {
  const calls = new Map<string, ToolCallBlock>();
  const out: ResultInfo[] = [];
  messages.forEach((m, msgIndex) => {
    for (const b of m.content) {
      if (b.type === 'tool-call') calls.set(b.id, b);
      else if (b.type === 'tool-result') {
        const args = calls.get(b.toolCallId)?.args as { path?: unknown } | undefined;
        out.push({
          callId: b.toolCallId,
          name: b.name,
          ...(typeof args?.path === 'string' ? { path: normalizePath(args.path) } : {}),
          isError: b.isError ?? false,
          msgIndex,
          block: b,
        });
      }
    }
  });
  return out;
}

export function dedupCandidates(state: HistoryState): string[] {
  const results = toolResults(state.messages);
  const out: string[] = [];
  results.forEach((r, i) => {
    if (r.name !== 'read' || !r.path || r.isError || state.context.elided[r.callId] || state.context.pinned?.[r.callId]) return;
    const superseded = results.slice(i + 1).some((later) => later.path === r.path && PATH_TOOLS.has(later.name) && !later.isError && (later.name === 'read' || WRITE_TOOLS.has(later.name)));
    if (superseded) out.push(r.callId);
  });
  return out;
}

/** 消息下标 → 所属 turn */
export function turnOfIndex(state: HistoryState): (index: number) => number {
  const starts = Object.entries(state.turnStarts)
    .map(([t, msgs]) => ({ turn: Number(t), start: msgs.length }))
    .sort((a, b) => a.start - b.start || a.turn - b.turn);
  return (index) => {
    let turn = 0;
    for (const s of starts) if (s.start <= index) turn = s.turn;
    return turn;
  };
}

function previewOf(text: string, lines: number): string {
  const all = text.split('\n');
  if (all.length <= lines * 2) return text;
  return [...all.slice(0, lines), `… 省略 ${all.length - lines * 2} 行 …`, ...all.slice(-lines)].join('\n');
}

export interface AgingResult {
  ids: string[];
  previews: Record<string, string>;
  tokens: Record<string, number>;
}

export function agingCandidates(state: HistoryState, cfg: ContextConfig): AgingResult {
  const turnOf = turnOfIndex(state);
  const out: AgingResult = { ids: [], previews: {}, tokens: {} };
  for (const r of toolResults(state.messages)) {
    if (state.context.elided[r.callId] || state.context.pinned?.[r.callId]) continue;
    if (state.turn - turnOf(r.msgIndex) < cfg.agingTurns) continue;
    const tokens = estimateBlock(r.block);
    if (tokens < cfg.agingMinTokens) continue;
    const text = r.block.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    out.ids.push(r.callId);
    out.previews[r.callId] = previewOf(text, cfg.previewLines);
    out.tokens[r.callId] = tokens;
  }
  return out;
}

/** 压缩切点：保留最近 keepTurns 个 turn 的原文；必须晚于已有压缩点；没有合适切点返回 null */
export function chooseCut(state: HistoryState, keepTurns: number): number | null {
  const starts = Object.values(state.turnStarts)
    .map((m) => m.length)
    .filter((i) => {
      const msg = state.messages[i];
      return msg?.role === 'user' && msg.content.some((b) => b.type === 'text');
    })
    .sort((a, b) => a - b);
  if (starts.length <= keepTurns) return null;
  const cut = starts[starts.length - keepTurns]!;
  const floor = state.context.compaction?.upTo ?? 0;
  return cut > floor ? cut : null;
}
