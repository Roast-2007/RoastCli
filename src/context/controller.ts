/**
 * ContextController：上下文引擎的调度器（经 boundary 钩子接入运行时）。
 * - 观察提交的事件：request/digest + 随后的 usage → 锚点（真实 tokens）与估算校准
 * - 每个 step 前：候选折叠（dedup/aging）按 CachePlanner 规则批量应用；超阈值时压缩
 * - 溢出（CONTEXT_WINDOW_EXCEEDED）：强制压缩，运行时据此重试一次
 * 所有决策以 context/transform、context/compact 事件落日志，回放不重算。
 */
import type { Message } from '../core/types.js';
import type { SessionEvent, SessionEventBody } from '../session/events.js';
import type { HistoryState } from '../session/history.js';
import type { BoundaryCtx, BoundaryHooks, BoundaryAction } from '../agent/boundary.js';
import { Calibrator, estimateMessages } from './estimator.js';
import { agingCandidates, chooseCut, dedupCandidates, DEFAULT_CONTEXT_CONFIG, toolResults, type ContextConfig } from './policies.js';
import { buildView } from './view.js';
import { extractiveSummarizer, type Summarizer } from './compactor.js';
import { estimateBlock } from './estimator.js';

const STUB_TOKENS = 60;

export interface ContextControllerOptions {
  window: number;
  config?: Partial<ContextConfig>;
  summarizer?: Summarizer;
  /** system prompt + 工具 schema 的估算 tokens */
  overhead: () => number;
  now?: () => number;
}

export interface ContextStats {
  window: number;
  estimated: number;
  percent: number;
  breakdown: { overhead: number; user: number; assistant: number; toolResults: number; summary: number };
  elidedCount: number;
  compactedUpTo: number | null;
  calibration: number;
  anchored: boolean;
  /** 占用最大的工具结果（含已折叠 / 已钉住标记） */
  largest: LargestItem[];
}

export interface LargestItem {
  id: string;
  name: string;
  path?: string;
  tokens: number;
  elided: boolean;
  pinned: boolean;
}

const LARGEST_LIMIT = 6;

interface Anchor {
  messageCount: number;
  tokens: number;
}

export class ContextController {
  readonly config: ContextConfig;
  private readonly calibrator = new Calibrator();
  private readonly summarizer: Summarizer;
  private readonly now: () => number;
  private anchor: Anchor | null = null;
  private pendingDigest: { messageCount: number; estimate: number } | null = null;
  private lastRequestAt = 0;
  private commit: ((body: SessionEventBody) => unknown) | null = null;
  private getState: (() => HistoryState) | null = null;

  constructor(private readonly opts: ContextControllerOptions) {
    this.config = { ...DEFAULT_CONTEXT_CONFIG, ...opts.config };
    this.summarizer = opts.summarizer ?? extractiveSummarizer;
    this.now = opts.now ?? Date.now;
  }

  attach(commit: (body: SessionEventBody) => unknown, getState: () => HistoryState): void {
    this.commit = commit;
    this.getState = getState;
  }

  setWindow(window: number): void {
    this.opts.window = window;
    this.anchor = null;
    this.pendingDigest = null;
  }

  /** 订阅 Committer：建立锚点、校准估算 */
  observe(ev: SessionEvent): void {
    if (ev.type === 'request/digest' && this.getState) {
      const view = buildView(this.getState());
      this.pendingDigest = { messageCount: view.length, estimate: this.opts.overhead() + estimateMessages(view) };
      this.lastRequestAt = this.now();
    } else if (ev.type === 'usage' && this.pendingDigest) {
      const actual = ev.usage.input + ev.usage.cacheRead + ev.usage.cacheWrite;
      if (actual > 0) {
        this.calibrator.observe(this.pendingDigest.estimate, actual);
        this.anchor = { messageCount: this.pendingDigest.messageCount, tokens: actual };
      }
    } else if (ev.type === 'context/transform' || ev.type === 'context/compact' || ev.type === 'rewind') {
      this.anchor = null; // 视图前缀变了，锚点失效
    }
  }

  /** 当前视图的 token 估算：锚点 + 增量；无锚点时全量估算 × 校准系数 */
  estimate(state: HistoryState): number {
    const view = buildView(state);
    if (this.anchor && this.anchor.messageCount <= view.length) {
      return this.anchor.tokens + this.calibrator.adjust(estimateMessages(view.slice(this.anchor.messageCount)));
    }
    return this.calibrator.adjust(this.opts.overhead() + estimateMessages(view));
  }

  hooks(): BoundaryHooks {
    return {
      beforeRequest: async (ctx) => this.maintain(ctx.signal, {}),
      onOverflow: async (ctx: BoundaryCtx) => (await this.maintain(ctx.signal, { forceCompact: true, keepTurns: 1 })).length > 0,
    };
  }

  /** 应用折叠 / 压缩；返回给 UI 的提示（空数组 = 无变化） */
  async maintain(signal: AbortSignal, opt: { forceCompact?: boolean; keepTurns?: number; focus?: string }): Promise<BoundaryAction[]> {
    if (!this.getState || !this.commit) return [];
    const notices: BoundaryAction[] = [];
    const elided = this.applyElisions(this.getState(), opt.forceCompact === true);
    if (elided > 0) notices.push({ kind: 'notice', text: `已折叠旧的工具结果，约节省 ${elided} tokens（可 recall 取回）` });
    const state = this.getState();
    if (opt.forceCompact || this.estimate(state) > this.config.compactAt * this.opts.window) {
      const saved = await this.compact(state, opt.keepTurns ?? this.config.keepTurns, opt.focus, signal);
      if (saved > 0) notices.push({ kind: 'notice', text: `上下文已压缩，约节省 ${saved} tokens（原文可 recall）` });
    }
    return notices;
  }

  private applyElisions(state: HistoryState, force: boolean): number {
    const dedup = dedupCandidates(state);
    const aging = agingCandidates(state, this.config);
    const agingIds = aging.ids.filter((id) => !dedup.includes(id));
    if (dedup.length + agingIds.length === 0) return 0;
    const blocks = new Map(toolResults(state.messages).map((r) => [r.callId, r.block]));
    const tokensOf = (id: string) => Math.max(0, (blocks.get(id) ? estimateBlock(blocks.get(id)!) : 0) - STUB_TOKENS);
    const savings = [...dedup, ...agingIds].reduce((n, id) => n + tokensOf(id), 0);
    const est = this.estimate(state);
    const idle = this.lastRequestAt > 0 && this.now() - this.lastRequestAt > this.config.cacheTtlMs;
    const worthIt = savings >= this.config.minSavings && (est > this.config.elideAt * this.opts.window || idle);
    if (!force && !worthIt) return 0;
    const ops = [
      ...(dedup.length ? [{ op: 'elide' as const, ids: dedup, reason: '已被后续读取或修改取代', tokens: Object.fromEntries(dedup.map((id) => [id, tokensOf(id)])) }] : []),
      ...(agingIds.length
        ? [{ op: 'elide' as const, ids: agingIds, reason: '较早的工具结果', previews: pick(aging.previews, agingIds), tokens: pick(aging.tokens, agingIds) }]
        : []),
    ];
    this.commit!({ type: 'context/transform', at: new Date(this.now()).toISOString(), ops });
    return savings;
  }

  private async compact(state: HistoryState, keepTurns: number, focus: string | undefined, signal: AbortSignal): Promise<number> {
    const cut = chooseCut(state, keepTurns);
    if (cut === null) return 0;
    const prefix: Message[] = buildView({ ...state, messages: state.messages.slice(0, cut) });
    const { summary, usage } = await this.summarizer.summarize(prefix, focus, signal);
    if (signal.aborted || !summary.trim()) return 0;
    const before = this.estimate(state);
    this.commit!({
      type: 'context/compact',
      at: new Date(this.now()).toISOString(),
      upTo: cut,
      summary,
      ...(focus ? { focus } : {}),
      ...(usage.input + usage.output > 0 ? { auxUsage: usage } : {}),
    });
    return Math.max(0, before - this.estimate(this.getState!()));
  }

  /** /compact：立即压缩（保留最近 1 个 turn） */
  async compactNow(focus?: string): Promise<number> {
    if (!this.getState) return 0;
    return this.compact(this.getState(), 1, focus, new AbortController().signal);
  }

  /**
   * /context pin | unpin | drop：用户手动调整（落 context/transform 日志，resume 一致）。
   * 返回给用户的说明；未知 id 不做任何修改。
   */
  manual(state: HistoryState, action: 'pin' | 'unpin' | 'drop', ids: string[]): string {
    const blocks = new Map(toolResults(state.messages).map((r) => [r.callId, r.block]));
    const unknown = ids.filter((id) => !blocks.has(id));
    if (unknown.length) return `没有这些工具结果：${unknown.join(', ')}（用 /context 查看可用 id）`;
    if (!this.commit) return '上下文引擎未就绪';
    const op =
      action === 'drop'
        ? { op: 'elide' as const, ids, reason: '用户手动折叠', tokens: Object.fromEntries(ids.map((id) => [id, estimateBlock(blocks.get(id)!)])) }
        : { op: action, ids };
    this.commit({ type: 'context/transform', at: new Date(this.now()).toISOString(), ops: [op] });
    const verb = { pin: '已钉住（不会被自动折叠）', unpin: '已取消钉住', drop: '已折叠（可 recall 取回）' }[action];
    return `${verb}：${ids.join(', ')}`;
  }

  /** 视图中占用最大的工具结果（/context 列表） */
  largest(state: HistoryState, limit = LARGEST_LIMIT): LargestItem[] {
    return toolResults(state.messages)
      .map((r) => ({
        id: r.callId,
        name: r.name,
        ...(r.path ? { path: r.path } : {}),
        tokens: state.context.elided[r.callId]?.tokens ?? estimateBlock(r.block),
        elided: state.context.elided[r.callId] !== undefined,
        pinned: state.context.pinned?.[r.callId] === true,
      }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, limit);
  }

  stats(state: HistoryState): ContextStats {
    const view = buildView(state);
    const breakdown = { overhead: this.opts.overhead(), user: 0, assistant: 0, toolResults: 0, summary: 0 };
    view.forEach((m, i) => {
      for (const b of m.content) {
        const t = estimateBlock(b);
        if (b.type === 'tool-result') breakdown.toolResults += t;
        else if (b.type === 'text' && i === 0 && state.context.compaction && b.text.startsWith('<summary>')) breakdown.summary += t;
        else if (m.role === 'assistant') breakdown.assistant += t;
        else breakdown.user += t;
      }
    });
    const estimated = this.estimate(state);
    return {
      window: this.opts.window,
      estimated,
      percent: Math.round((estimated / this.opts.window) * 100),
      breakdown,
      elidedCount: Object.keys(state.context.elided).length,
      compactedUpTo: state.context.compaction?.upTo ?? null,
      calibration: Math.round(this.calibrator.factor * 100) / 100,
      anchored: this.anchor !== null,
      largest: this.largest(state),
    };
  }
}

function pick<T>(rec: Record<string, T>, ids: string[]): Record<string, T> {
  return Object.fromEntries(ids.filter((id) => id in rec).map((id) => [id, rec[id]!]));
}
