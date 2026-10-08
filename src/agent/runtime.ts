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
import type { GenerateOptions, TokenUsage, Message } from '../core/types.js';
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
import { renderBrief, type MissionInput } from '../swarm/strategies.js';

export type RuntimeInput = string | Message | MissionInput;
function isMission(input: RuntimeInput): input is MissionInput {
  return typeof input === 'object' && 'kind' in input && input.kind === 'mission';
}
function inputText(input: RuntimeInput): string {
  return typeof input === 'string'
    ? input
    : isMission(input)
      ? input.goal
      : input.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
}

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
  budgetReminder?: 'main' | 'agent';
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
  onPartial?(turn: number, text: string, at: string): void;
}

export class AgentRuntime {
  readonly id: string;
  readonly committer: Committer;
  private readonly maxSteps: number;
  private readonly clock: Clock;
  private turn: number;
  private inbox: RuntimeInput[] = [];
  private missionSeq = 0;
  private active = false;
  private lastSystemHash = '';
  private lastToolsHash = '';
  private cachePrefix: string[] = [];
  private lastCacheKey = '';
  private idleWaiters: (() => void)[] = [];
  private pauseGate: Promise<void> | null = null;
  private resumeGate: (() => void) | null = null;

  get paused(): boolean {
    return this.pauseGate !== null;
  }
  /** Pause at the next request boundary; never leave a tool call without its result. */
  setPaused(paused: boolean): void {
    if (paused && !this.pauseGate)
      this.pauseGate = new Promise((resolve) => {
        this.resumeGate = resolve;
      });
    if (!paused) {
      this.resumeGate?.();
      this.pauseGate = null;
      this.resumeGate = null;
    }
  }

  constructor(private readonly deps: AgentRuntimeDeps) {
    this.id = deps.agentId ?? deps.log.agentId;
    this.maxSteps = deps.maxSteps ?? 100;
    this.clock = deps.clock ?? realClock;
    this.committer = new Committer(deps.log, deps.initialHistory);
    this.turn = deps.initialHistory?.turn ?? 0;
    this.missionSeq = deps.initialHistory?.missionSeq ?? 0;
  }

  get busy(): boolean {
    return this.active;
  }

  /**
   * 运行中排队一条插话（下一个 step 边界送达）。返回 false 表示当前空闲、未入队，调用方应自行 run。
   */
  enqueue(text: RuntimeInput): boolean {
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
  async *run(userText: RuntimeInput, signal?: AbortSignal): AsyncGenerator<UiEvent> {
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
        const first = this.inbox.shift()!;
        yield* this.runTurn(first, signal);
      }
      if (signal.aborted && this.inbox.length > 0) {
        yield { type: 'queue-restored', texts: this.inbox.map(inputText) };
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

  private async *runTurn(firstText: RuntimeInput, signal: AbortSignal): AsyncGenerator<UiEvent> {
    const commit = this.committer.commit.bind(this.committer);
    const turn = ++this.turn;
    let usage: TokenUsage = emptyUsage();
    const end = (reason: TurnEndReason, error?: RoastError) => this.endTurn(turn, usage, reason, error);

    commit({ type: 'turn/start', turn, at: this.now() });
    yield { type: 'turn-start', turn };
    try {
      const rawText = inputText(firstText);
      const mission = isMission(firstText) ? firstText : undefined;
      const text = await this.prepareInput(rawText, signal, mission ? { strategy: mission.strategy.name, n: mission.n } : undefined);
      if (typeof text !== 'string') {
        yield* end('error', new RoastError('INVALID_REQUEST', text.blocked));
        return;
      }
      if (mission) {
        const missionId = `m${++this.missionSeq}`;
        const brief = renderBrief({
          missionId,
          goal: mission.goal,
          strategy: mission.strategy.name,
          n: mission.n,
          readOnly: mission.strategy.readOnly,
          playbook: mission.strategy.playbook,
        });
        const extra = text === rawText ? '' : text.startsWith(rawText) ? text.slice(rawText.length) : `\n\n[Input context]\n${text}`;
        const event = commit({
          type: 'hive/mission',
          turn,
          at: this.now(),
          missionId,
          goal: mission.goal,
          strategy: mission.strategy.name,
          n: mission.n,
          brief: brief + extra,
          ...(mission.images?.length ? { images: mission.images } : {}),
          ...(mission.strategy.readOnly ? { readOnly: true } : {}),
        });
        yield event as Extract<UiEvent, { type: 'hive/mission' }>;
      } else {
        const message = userMessage(text);
        if (typeof firstText !== 'string' && 'content' in firstText)
          message.content.push(...firstText.content.filter((b) => b.type === 'image'));
        commit({ type: 'user/message', turn, at: this.now(), message, source: 'user' });
      }

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
            yield { type: 'stream-reset' };
            yield { type: 'notice', text: '上下文超出窗口，已紧急压缩并重试' };
            step--; // 以同一 step 编号重试
            continue;
          }
        }
        if (outcome.kind === 'failed') {
          if (outcome.text?.trim()) {
            this.deps.onPartial?.(turn, outcome.text, this.now());
            yield { type: 'partial', text: outcome.text };
          } else yield { type: 'stream-reset' };
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
        yield { type: 'stream-commit' };

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
  private async prepareInput(
    text: string,
    signal: AbortSignal,
    hive?: { strategy: string; n: number },
  ): Promise<string | { blocked: string }> {
    let out = text;
    const guard = this.deps.extensions?.inputGuard;
    if (guard) {
      const verdict = await guard.check(out, 'user', { signal, ...(hive ? { hive } : {}) });
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
        const queued = this.inbox.shift()!;
        const raw = inputText(queued);
        // 插话与首条输入同样经过 inputGuard / RAG
        const text = await this.prepareInput(raw, signal);
        if (typeof text !== 'string') {
          yield { type: 'error', error: new RoastError('INVALID_REQUEST', `插话未送达模型：${text.blocked}`) };
          continue;
        }
        const message = userMessage(text);
        const images =
          typeof queued === 'string' ? [] : isMission(queued) ? (queued.images ?? []) : queued.content.filter((b) => b.type === 'image');
        message.content.push(...images);
        this.committer.commit({ type: 'user/message', turn, at: this.now(), message, source: 'steer' });
        yield { type: 'user-injected', text: raw, ...(images.length ? { images } : {}) };
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
    this.injectBudget(turn, step);
  }

  /** 内部附件只进入模型历史；日志标记防止同一步的溢出重试重复提醒。 */
  private injectBudget(turn: number, step: number): void {
    if (!this.deps.budgetReminder || this.committer.state.budgetMarks?.includes(`${turn}:${step}`)) return;
    const remaining = this.maxSteps - step + 1;
    const wrapUp = this.maxSteps >= 20 ? 5 : 2;
    if (remaining !== wrapUp && remaining !== 1) return;
    const agent = this.deps.budgetReminder === 'agent';
    const text =
      remaining === 1
        ? `[最后一步] 这是本回合最后一个步骤：${agent ? '现在只调用 report。' : '请直接给出结论。'}`
        : `[步数提醒] 本回合还剩 ${remaining} 个模型步骤（上限 ${this.maxSteps}）。请停止扩展范围，保存成果并运行必要验证，然后${agent ? '调用 report 提交结论（未完成用 status "partial" 说明已完成与剩余部分）。' : '给出当前结论与剩余工作。'}`;
    this.committer.commit({ type: 'attachment/injected', turn, step, at: this.now(), source: 'budget', blocks: [{ type: 'text', text }] });
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
    const cacheKey = hashOf([this.deps.cwd, this.deps.modelRef.provider, model, systemHash, toolsHash]);
    const prefix = messages.map((message) => hashOf(message));
    let cacheBoundary = 0;
    if (cacheKey === this.lastCacheKey)
      while (cacheBoundary < prefix.length && prefix[cacheBoundary] === this.cachePrefix[cacheBoundary]) cacheBoundary++;
    const request: Omit<GenerateOptions, 'signal'> = {
      model,
      system,
      cacheKey,
      ...(cacheBoundary > 0 ? { cacheBoundary } : {}),
      ...(this.deps.modelRef.reasoningEffort !== undefined ? { reasoningEffort: this.deps.modelRef.reasoningEffort } : {}),
      messages,
      tools,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(this.deps.temperature !== undefined ? { temperature: this.deps.temperature } : {}),
    };
    this.cachePrefix = prefix;
    this.lastCacheKey = cacheKey;
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
