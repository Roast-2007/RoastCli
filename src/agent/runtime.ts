/**
 * AgentRuntime：事件溯源的 agent 运行时（替换旧 AgentLoop 内核，对外契约不变）。
 *
 * turn（一次用户输入）→ step（一次模型请求 + 工具阶段）。所有状态变更经 Committer
 * （写日志 → reducer），实时运行与 resume 同一路径。
 *
 * - 输入走队列：run(text) = 入队 + drive；运行中 enqueue(text) 的插话在下一个 step 边界送达
 * - 边界钩子：beforeRequest 注入附件；onWouldEndTurn 可 wait（不耗 token）/ continue
 * - 重试在 runStep 内；中断全链路贯通，未送达的插话以 queue-restored 交还 UI
 */
import { asRoastError, RoastError } from '../core/errors.js';
import { addUsage, emptyUsage, toolCallsOf, userMessage } from '../core/types.js';
import type { GenerateOptions, TokenUsage } from '../core/types.js';
import type { ModelRef } from '../core/config.js';
import type { ProviderRegistry } from '../providers/adapter.js';
import type { ToolContext, ToolExecutorHooks, ToolRegistry, ToolServices } from '../tools/index.js';
import { emptyHooks } from '../tools/index.js';
import type { RunLogWriter } from '../session/log-writer.js';
import { hashMessages, hashOf, type HistoryState } from '../session/history.js';
import type { ExtensionPoints } from '../ext/index.js';
import type { SystemPromptAssembler } from './system-prompt.js';
import { Committer } from './committer.js';
import { DEFAULT_RETRY, realClock, type Clock, type RetryPolicy } from './retry.js';
import { runStep } from './step.js';
import { runToolPhase } from './tool-phase.js';
import { abortable, type BoundaryCtx, type BoundaryHooks } from './boundary.js';
import type { TurnEndReason, UiEvent } from './ui-events.js';
import { buildView } from '../context/view.js';

export interface AgentRuntimeDeps {
  agentId?: string;
  providers: ProviderRegistry;
  modelRef: ModelRef;
  tools: ToolRegistry;
  systemPrompt: SystemPromptAssembler;
  log: RunLogWriter;
  cwd: string;
  services: ToolServices;
  hooks?: ToolExecutorHooks;
  extensions?: ExtensionPoints;
  boundary?: BoundaryHooks;
  maxSteps?: number;
  temperature?: number;
  /** true 时落完整请求体与流式 chunk */
  debugLog?: boolean;
  retry?: RetryPolicy;
  clock?: Clock;
  random?: () => number;
  /** resume：从日志折叠出的初始历史 */
  initialHistory?: HistoryState;
  /** 外层（CLI/UI）的中断信号 */
  signal?: AbortSignal;
}

export class AgentRuntime {
  readonly id: string;
  readonly committer: Committer;
  private readonly maxSteps: number;
  private readonly clock: Clock;
  private turn: number;
  private inbox: string[] = [];
  private active = false;
  private lastSystemHash = '';
  private lastToolsHash = '';
  private idleWaiters: (() => void)[] = [];
  private pauseGate: Promise<void> | null = null;
  private resumeGate: (() => void) | null = null;

  get paused(): boolean { return this.pauseGate !== null; }
  /** Pause at the next request boundary; never leave a tool call without its result. */
  setPaused(paused: boolean): void {
    if (paused && !this.pauseGate) this.pauseGate = new Promise((resolve) => { this.resumeGate = resolve; });
    if (!paused) { this.resumeGate?.(); this.pauseGate = null; this.resumeGate = null; }
  }

  constructor(private readonly deps: AgentRuntimeDeps) {
    this.id = deps.agentId ?? deps.log.agentId;
    this.maxSteps = deps.maxSteps ?? 50;
    this.clock = deps.clock ?? realClock;
    this.committer = new Committer(deps.log, deps.initialHistory);
    this.turn = deps.initialHistory?.turn ?? 0;
  }

  get busy(): boolean {
    return this.active;
  }

  /**
   * 运行中排队一条插话（下一个 step 边界送达）。返回 false 表示当前空闲、未入队，调用方应自行 run。
   */
  enqueue(text: string): boolean {
    if (!this.active) return false;
    this.inbox.push(text);
    return true;
  }

  /** 当前 drive 结束（空闲）时 resolve；已空闲则立即 resolve */
  whenIdle(): Promise<void> {
    if (!this.active) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  /** 入队并驱动直到空闲（运行中调用等同于 enqueue，事件由正在进行的 drive 产出） */
  async *run(userText: string, signal?: AbortSignal): AsyncGenerator<UiEvent> {
    this.inbox.push(userText);
    yield* this.drive(signal);
  }

  async *drive(runSignal?: AbortSignal): AsyncGenerator<UiEvent> {
    if (this.active) return;
    this.active = true;
    const signals = [this.deps.signal, runSignal].filter((s): s is AbortSignal => !!s);
    const signal = signals.length === 0 ? new AbortController().signal : AbortSignal.any(signals);
    try {
      while (this.inbox.length > 0) {
        if (signal.aborted) break;
        const first = this.inbox.shift() as string;
        yield* this.runTurn(first, signal);
      }
      if (signal.aborted && this.inbox.length > 0) {
        yield { type: 'queue-restored', texts: this.inbox };
        this.inbox = [];
      }
    } finally {
      this.active = false;
      this.setPaused(false);
      this.committer.flush();
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of waiters) w();
    }
  }

  private now(): string {
    return new Date(this.clock.now()).toISOString();
  }

  private async *runTurn(firstText: string, signal: AbortSignal): AsyncGenerator<UiEvent> {
    const commit = this.committer.commit.bind(this.committer);
    const turn = ++this.turn;
    let usage: TokenUsage = emptyUsage();
    const end = (reason: TurnEndReason, error?: RoastError) => this.endTurn(turn, usage, reason, error);

    commit({ type: 'turn/start', turn, at: this.now() });
    yield { type: 'turn-start', turn };
    try {
      const text = await this.prepareInput(firstText, signal);
      if (typeof text !== 'string') {
        yield* end('error', new RoastError('INVALID_REQUEST', text.blocked));
        return;
      }
      commit({ type: 'user/message', turn, at: this.now(), message: userMessage(text), source: 'user' });

      let overflowRetried = false;
      for (let step = 1; step <= this.maxSteps; step++) {
        if (this.pauseGate) {
          yield { type: 'waiting', reason: '已暂停；恢复后继续当前回合' };
          await abortable(this.pauseGate, signal);
        }
        if (signal.aborted) throw new RoastError('ABORTED', '被中断');
        yield* this.boundary(turn, step, signal);
        // 没有任何新内容（历史以 assistant 结尾）：不发请求，避免 prefill 式请求被模型拒绝
        if (this.committer.messages().at(-1)?.role === 'assistant') {
          yield* end('completed');
          return;
        }
        const request = this.buildRequest(turn, step);
        const outcome = yield* runStep(request, {
          adapter: this.deps.providers.get(this.deps.modelRef),
          retry: this.deps.retry ?? DEFAULT_RETRY,
          clock: this.clock,
          ...(this.deps.random ? { random: this.deps.random } : {}),
          debugLog: this.deps.debugLog ?? false,
          turn,
          step,
          signal,
          commit,
        });
        usage = addUsage(usage, outcome.usage);
        if (outcome.kind === 'failed' && outcome.error.code === 'CONTEXT_WINDOW_EXCEEDED' && !overflowRetried) {
          const reduced = await this.deps.boundary?.onOverflow?.(this.boundaryCtx(turn, step, signal));
          if (reduced) {
            overflowRetried = true;
            yield { type: 'notice', text: '上下文超出窗口，已紧急压缩并重试' };
            step--; // 以同一 step 编号重试
            continue;
          }
        }
        if (outcome.kind === 'failed') {
          yield* end(outcome.aborted ? 'aborted' : 'error', outcome.error);
          return;
        }
        commit({
          type: 'assistant/message',
          turn,
          step,
          at: this.now(),
          message: outcome.message,
          usage: outcome.usage,
          finishReason: outcome.finishReason,
        });

        const calls = toolCallsOf(outcome.message);
        if (calls.length === 0) {
          const decision = yield* this.decideEndOfTurn(turn, step, signal);
          if (decision === 'end') {
            yield* end('completed');
            return;
          }
          continue;
        }
        const ctx: ToolContext = { cwd: this.deps.cwd, signal, services: this.deps.services, agentId: this.id, turn };
        yield* runToolPhase(calls, {
          turn,
          step,
          registry: this.deps.tools,
          ctx,
          hooks: this.composedHooks(),
          commit,
          now: () => this.now(),
        });
      }
      yield* end('max-steps', new RoastError('UNKNOWN', `达到最大步数上限（${this.maxSteps}），已停止`));
    } catch (err) {
      const e = asRoastError(err);
      yield* end(e.code === 'ABORTED' ? 'aborted' : 'error', e);
    }
  }

  private *endTurn(turn: number, usage: TokenUsage, reason: TurnEndReason, error?: RoastError): Generator<UiEvent> {
    if (error) {
      this.committer.commit({ type: 'error', at: this.now(), where: 'agent-runtime', code: error.code, message: error.message });
      yield { type: 'error', error };
    }
    this.committer.commit({ type: 'turn/end', turn, at: this.now(), reason, ...(error ? { error: error.message } : {}) });
    this.committer.flush();
    yield { type: 'turn-end', reason, usage };
  }

  /** inputGuard（含 UserPromptSubmit 钩子）+ RAG；被拦截返回 { blocked: 理由 } */
  private async prepareInput(text: string, signal: AbortSignal): Promise<string | { blocked: string }> {
    let out = text;
    const guard = this.deps.extensions?.inputGuard;
    if (guard) {
      const verdict = await guard.check(out, 'user', { signal });
      if (verdict.action === 'block') return { blocked: verdict.reason ?? '输入被安全守卫拦截' };
      if (verdict.action === 'sanitize' && verdict.sanitized !== undefined) out = verdict.sanitized;
    }
    const rag = this.deps.extensions?.rag;
    if (rag) {
      const chunks = await rag.retrieve(out, { signal });
      if (chunks.length > 0) {
        const ctxText = chunks.map((c) => `--- ${c.source} ---\n${c.content}`).join('\n\n');
        out = `${out}\n\n[Retrieved context]\n${ctxText}`;
      }
    }
    return out;
  }

  private boundaryCtx(turn: number, step: number, signal: AbortSignal): BoundaryCtx {
    return { agentId: this.id, turn, step, signal, messages: () => this.committer.messages() };
  }

  /** step 边界：送达排队插话 → 外部钩子注入附件 */
  private async *boundary(turn: number, step: number, signal: AbortSignal): AsyncGenerator<UiEvent> {
    if (step > 1) {
      while (this.inbox.length > 0) {
        const raw = this.inbox.shift() as string;
        // 插话与首条输入同样经过 inputGuard / RAG
        const text = await this.prepareInput(raw, signal);
        if (typeof text !== 'string') {
          yield { type: 'error', error: new RoastError('INVALID_REQUEST', `插话未送达模型：${text.blocked}`) };
          continue;
        }
        this.committer.commit({ type: 'user/message', turn, at: this.now(), message: userMessage(text), source: 'steer' });
        yield { type: 'user-injected', text: raw };
      }
    }
    const actions = (await this.deps.boundary?.beforeRequest?.(this.boundaryCtx(turn, step, signal))) ?? [];
    for (const a of actions) {
      if (a.kind === 'notice') {
        yield { type: 'notice', text: a.text };
        continue;
      }
      if (a.blocks.length === 0) continue;
      this.committer.commit({ type: 'attachment/injected', turn, step, at: this.now(), source: a.source, blocks: a.blocks });
    }
  }

  /** 模型无工具调用时：有排队插话则继续；否则询问钩子（可等待，不耗 token） */
  private async *decideEndOfTurn(turn: number, step: number, signal: AbortSignal): AsyncGenerator<UiEvent, 'end' | 'continue'> {
    for (;;) {
      // 有排队插话：步数未用尽则在本 turn 继续；否则结束本 turn，插话由 drive 作为新 turn 处理
      if (this.inbox.length > 0) return step < this.maxSteps ? 'continue' : 'end';
      const hook = this.deps.boundary?.onWouldEndTurn;
      if (!hook) return 'end';
      const d = await hook(this.boundaryCtx(turn, step, signal));
      if (d.kind !== 'wait') return d.kind;
      yield { type: 'waiting', reason: d.reason };
      await abortable(d.until, signal);
      if (signal.aborted) throw new RoastError('ABORTED', '等待中被中断');
    }
  }

  private buildRequest(turn: number, step: number): Omit<GenerateOptions, 'signal'> {
    const { model } = this.deps.modelRef;
    const commit = this.committer.commit.bind(this.committer);
    const system = this.deps.systemPrompt.assemble();
    const systemHash = hashOf(system);
    if (systemHash !== this.lastSystemHash) {
      commit({ type: 'system/snapshot', at: this.now(), hash: systemHash, text: system });
      this.lastSystemHash = systemHash;
    }
    const tools = this.deps.tools.schemas();
    const toolsHash = hashOf(tools);
    if (toolsHash !== this.lastToolsHash) {
      commit({ type: 'tools/snapshot', at: this.now(), hash: toolsHash, schemas: tools });
      this.lastToolsHash = toolsHash;
    }
    const maxTokens = this.deps.providers.get(this.deps.modelRef).resolveModel?.(model)?.maxTokens;
    // 发给模型的是"视图"：折叠 / 压缩后的历史（原文仍在历史与日志中）
    const messages = buildView(this.committer.state);
    const request: Omit<GenerateOptions, 'signal'> = {
      model,
      system,
      ...(this.deps.modelRef.reasoningEffort !== undefined ? { reasoningEffort: this.deps.modelRef.reasoningEffort } : {}),
      messages,
      tools,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(this.deps.temperature !== undefined ? { temperature: this.deps.temperature } : {}),
    };
    commit({ type: 'step/start', turn, step, at: this.now() });
    commit({
      type: 'request/digest',
      turn,
      step,
      at: this.now(),
      model,
      systemHash,
      toolsHash,
      viewHash: hashMessages(messages),
      messageCount: messages.length,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    });
    if (this.deps.debugLog) commit({ type: 'request/body', turn, step, at: this.now(), request });
    return request;
  }

  /** 把 outputGuard（扩展缝）包装为工具管线 preExecute hook */
  private composedHooks(): ToolExecutorHooks {
    const base = this.deps.hooks ?? emptyHooks();
    const guard = this.deps.extensions?.outputGuard;
    if (!guard) return base;
    return {
      ...base,
      preExecute: [
        async (tool, args) => {
          const verdict = await guard.checkToolArgs(tool.name, args);
          if (verdict.action === 'block') return { action: 'deny', reason: verdict.reason ?? 'output guard 拦截' };
          if (verdict.action === 'sanitize' && verdict.sanitized !== undefined) {
            try {
              return { action: 'allow', args: JSON.parse(verdict.sanitized) };
            } catch {
              return { action: 'allow' };
            }
          }
          return { action: 'allow' };
        },
        ...base.preExecute,
      ],
    };
  }
}
