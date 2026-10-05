/**
 * Supervisor：蜂群的运行时中枢。
 * - agent 树：root（主会话 Queen）+ 派生的子 agent（各自独立的 AgentRuntime / 日志 / services / mailbox）
 * - 消息总线与黑板；报告（report）投递到父 agent 的 mailbox 并写入黑板 /reports/<id>
 * - wait：父 agent 等待后代（不耗 token）；收到提问等唤醒类消息时提前返回
 * - 结构上无死锁：只有"父等后代"这一种阻塞关系
 */
import path from 'node:path';
import type { AgentRuntime } from '../agent/runtime.js';
import type { BoundaryHooks } from '../agent/boundary.js';
import type { UiEvent } from '../agent/ui-events.js';
import type { ModelRef, ReasoningEffort } from '../core/config.js';
import { RunLogWriter } from '../session/log-writer.js';
import type { ToolServices } from '../tools/tool.js';
import { Blackboard } from './board.js';
import { MessageBus } from './bus.js';
import { Mailbox, renderInbox } from './mailbox.js';
import { ROLE_INFO, roleCard } from './roles.js';
import type { Address, AgentInfo, AgentRole, Envelope, Report } from './types.js';
import { formatMerge, reportWorktreeNote, wantsWorktree, worktreeNote, type IsolationMode, type WorktreeProvider } from './isolation.js';
import type { Worktree } from './worktree.js';
import { ProgressWatchdog } from './watchdog.js';

export interface CreateRuntimeInput {
  id: string;
  role: AgentRole;
  log: RunLogWriter;
  services: ToolServices;
  boundary: BoundaryHooks;
  modelRef: ModelRef;
  /** 该 agent 的工作目录（worktree 隔离时为 worktree 内的对应目录） */
  cwd: string;
  worktree?: Worktree;
}

export interface SupervisorDeps {
  /** 主日志路径（子 agent 日志写在同目录 agents/<id>.jsonl） */
  mainLogPath: string;
  runId: string;
  cwd: string;
  createRuntime(input: CreateRuntimeInput): AgentRuntime;
  createServices(agentId: string): ToolServices;
  modelFor(role: AgentRole, override?: string, effort?: ReasoningEffort | null): ModelRef;
  maxAgents?: number;
  maxDepth?: number;
  onAgentEvent?(agentId: string, ev: UiEvent): void;
  onChange?(): void;
  /** 子 agent 运行结束（释放租约等） */
  onAgentEnd?(agentId: string): void;
  /** 提问方等待回答的上限（毫秒），超时后不再等待 */
  questionWaitMs?: number;
  /** 单个子 agent 的运行时长上限（毫秒），超时取消其子树 */
  maxAgentMs?: number;
  /** git worktree 隔离（未提供时所有 agent 共享工作区） */
  worktrees?: WorktreeProvider;
  now?: () => number;
}

interface Rec {
  info: AgentInfo;
  mailbox: Mailbox;
  controller: AbortController;
  reported: Promise<Report>;
  resolveReport(r: Report): void;
  cwd: string;
  isolation: IsolationMode;
  worktree?: Worktree;
  merged?: boolean;
  /** 运行（含收尾）结束 */
  finished?: Promise<void>;
  runtime?: AgentRuntime;
}

export type SpawnResult = { ok: true; id: string } | { ok: false; reason: string };
export interface WaitResult {
  reason: 'done' | 'message' | 'timeout' | 'aborted';
  reports: Report[];
  pending: string[];
}

const LIVE: ReadonlySet<AgentInfo['state']> = new Set(['queued', 'running', 'waiting', 'paused']);
/** 合并前等待已 report 的下级完成收尾的上限 */
const FINISH_GRACE_MS = 5_000;

/** 等待 p 结束，最多 ms 毫秒（定时器会被清理，不拖住进程退出） */
async function settleWithin(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([p, new Promise((r) => (timer = setTimeout(r, ms)))]);
  } finally {
    clearTimeout(timer);
  }
}
export class Supervisor {
  readonly bus: MessageBus;
  readonly board: Blackboard;
  private readonly recs = new Map<string, Rec>();
  private readonly now: () => number;
  private seq = 0;
  private msgSeq = 0;
  /** 各 agent 已发出、尚未得到回答的提问（id 集合）：提问方无事可做时等待回答，而不是结束 */
  private readonly openQuestions = new Map<string, Set<string>>();
  private readonly runs = new Set<Promise<void>>();
  private readonly messageListeners = new Set<(e: Envelope, recipient: string) => void>();

  /** 订阅所有投递的消息（含报告、黑板通知等系统消息），供时间线展示 */
  onMessage(listener: (e: Envelope, recipient: string) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }
  /** 无进展看门狗：连续多少个 step 没有实质产出就提醒父 agent */
  private watchdogSteps = 12;

  setWatchdog(opts: { steps: number }): void {
    this.watchdogSteps = opts.steps;
  }

  constructor(private readonly deps: SupervisorDeps) {
    this.now = deps.now ?? Date.now;
    this.bus = new MessageBus({ resolve: (from, to) => this.resolve(from, to), deliver: (id, e) => this.deliver(id, e) }, { now: this.now });
    this.board = new Blackboard(
      (watcher, meta) =>
        this.deliver(watcher, this.systemEnvelope('board', watcher, 'info', `黑板更新 ${meta.key} v${meta.version}`, `${meta.author} 更新了 ${meta.key}（${meta.chars} 字），需要时 board_read 读取`)),
      this.now,
    );
    this.bus.onSend((e) => {
      if (e.kind === 'question') this.openQuestions.set(e.from, new Set([...(this.openQuestions.get(e.from) ?? []), e.id]));
    });
  }

  /** 所有子 agent 运行结束 */
  async whenIdle(): Promise<void> {
    while (this.runs.size > 0) await Promise.allSettled([...this.runs]);
  }

  registerRoot(id: string, model: string): void {
    this.recs.set(id, this.makeRec({ id, parentId: null, role: 'queen', depth: 0, state: 'running', brief: '主会话', model, startedAt: this.now(), children: [] }, this.deps.cwd));
  }

  setRootModel(model: string): void {
    for (const rec of this.recs.values()) if (rec.info.parentId === null) rec.info = { ...rec.info, model };
    this.deps.onChange?.();
  }

  private makeRec(info: AgentInfo, cwd: string, isolation: IsolationMode = 'shared'): Rec {
    let resolveReport!: (r: Report) => void;
    const reported = new Promise<Report>((r) => (resolveReport = r));
    return { info, mailbox: new Mailbox(), controller: new AbortController(), reported, resolveReport, cwd, isolation };
  }

  info(id: string): AgentInfo | undefined {
    return this.recs.get(id)?.info;
  }

  tree(): AgentInfo[] {
    return [...this.recs.values()].map((r) => r.info);
  }

  mailbox(id: string): Mailbox | undefined {
    return this.recs.get(id)?.mailbox;
  }

  activeChildren(id: string): string[] {
    return (this.recs.get(id)?.info.children ?? []).filter((c) => {
      const info = this.recs.get(c)?.info;
      return info !== undefined && LIVE.has(info.state) && !info.report;
    });
  }

  private resolve(from: string, to: Address): string[] | null {
    const me = this.recs.get(from)?.info;
    if (!me) return [];
    if (to === 'broadcast') return me.parentId === null ? this.tree().map((a) => a.id) : null;
    if ('agent' in to) return this.recs.has(to.agent) ? [to.agent] : [];
    if ('role' in to) return this.tree().filter((a) => a.role === to.role).map((a) => a.id);
    if ('topic' in to) return [];
    if (to.rel === 'parent') return me.parentId ? [me.parentId] : [];
    if (to.rel === 'children') return me.children;
    const parent = me.parentId ? this.recs.get(me.parentId)?.info : undefined;
    return parent ? parent.children : [];
  }

  private deliver(id: string, e: Envelope): void {
    if (e.kind === 'answer') {
      const open = this.openQuestions.get(id);
      if (open) {
        if (e.replyTo && open.has(e.replyTo)) open.delete(e.replyTo);
        else open.clear();
      }
    }
    this.recs.get(id)?.mailbox.enqueue(e);
    for (const l of this.messageListeners) l(e, id);
    this.deps.onChange?.();
  }

  private systemEnvelope(from: string, to: string, kind: Envelope['kind'], subject: string, body: string, refs: string[] = []): Envelope {
    return { id: `m-${from}-${++this.msgSeq}`, from, to: { agent: to }, kind, subject, body, refs, hop: 0, at: this.now() };
  }

  spawn(parentId: string, opts: { role: AgentRole; task: string; refs?: string[]; isolation?: IsolationMode; model?: string; reasoningEffort?: ReasoningEffort | null }): SpawnResult {
    const parent = this.recs.get(parentId);
    if (!parent) return { ok: false, reason: `未知的上级 ${parentId}` };
    if (opts.role === 'queen') return { ok: false, reason: '不能派生 queen' };
    const maxAgents = this.deps.maxAgents ?? 12;
    const maxDepth = this.deps.maxDepth ?? 3;
    if (this.recs.size - 1 >= maxAgents) return { ok: false, reason: `已达 agent 数量上限 ${maxAgents}` };
    if (parent.info.depth + 1 > maxDepth) return { ok: false, reason: `已达最大层级 ${maxDepth}` };
    if (parent.controller.signal.aborted) return { ok: false, reason: '上级已取消，不能派生新 agent' };
    let modelRef: ModelRef;
    try { modelRef = { ...this.deps.modelFor(opts.role, opts.model, opts.reasoningEffort) }; }
    catch (err) { return { ok: false, reason: err instanceof Error ? err.message : '模型选择失败' }; }
    const id = `${ROLE_INFO[opts.role].prefix}${++this.seq}`;
    const rec = this.makeRec({
      id,
      parentId,
      role: opts.role,
      depth: parent.info.depth + 1,
      state: 'running',
      brief: opts.task,
      model: `${modelRef.provider}:${modelRef.model}`,
      ...(modelRef.reasoningEffort !== undefined ? { reasoningEffort: modelRef.reasoningEffort } : {}),
      startedAt: this.now(),
      children: [],
    }, parent.cwd, opts.isolation ?? 'auto');
    parent.controller.signal.addEventListener('abort', () => rec.controller.abort(), { once: true });
    this.recs.set(id, rec);
    parent.info = { ...parent.info, children: [...parent.info.children, id] };
    const run = this.run(rec, modelRef, roleCard({ id, role: opts.role, parentId, task: opts.task, refs: opts.refs ?? [] }));
    rec.finished = run;
    this.runs.add(run);
    void run.finally(() => this.runs.delete(run));
    this.deps.onChange?.();
    return { ok: true, id };
  }

  /** 按隔离策略准备工作区；返回追加到角色卡的说明 */
  private async isolate(rec: Rec): Promise<string> {
    if (!this.deps.worktrees || !wantsWorktree(rec.isolation, rec.info.role)) return '';
    try {
      const worktrees = this.deps.worktrees;
      const wt = await this.serialize(rec.info.parentId ?? rec.info.id, () => worktrees.create(rec.info.id, rec.cwd));
      if (!wt) return '';
      rec.worktree = wt;
      rec.cwd = wt.cwd;
      rec.info = { ...rec.info, worktree: wt.root };
      return worktreeNote(wt);
    } catch (err) {
      return `\n（未能创建独立 worktree：${err instanceof Error ? err.message : String(err)}。你与上级共享工作区，修改文件前注意与同级协调）`;
    }
  }

  private async start(rec: Rec, modelRef: ModelRef): Promise<{ log: RunLogWriter; runtime: AgentRuntime; note: string }> {
    const id = rec.info.id;
    const note = await this.isolate(rec);
    const log = await RunLogWriter.create('', { cwd: rec.cwd, provider: modelRef.provider, model: modelRef.model }, {
      runDir: path.dirname(this.deps.mainLogPath),
      runId: this.deps.runId,
      fileName: path.join('agents', `${id}.jsonl`),
      agentId: id,
    });
    try {
      const runtime = this.deps.createRuntime({
        id, role: rec.info.role, log, services: this.deps.createServices(id), boundary: this.hooksFor(id), modelRef, cwd: rec.cwd,
        ...(rec.worktree ? { worktree: rec.worktree } : {}),
      });
      return { log, runtime, note };
    } catch (err) { await log.close().catch(() => {}); throw err; }
  }

  private async run(rec: Rec, modelRef: ModelRef, prompt: string): Promise<void> {
    const id = rec.info.id;
    let log: RunLogWriter | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastText = '';
    let lastReason = 'completed';
    let offWatchdog: (() => void) | undefined;
    const limit = this.deps.maxAgentMs ?? 60 * 60_000;
    try {
      const started = await this.start(rec, modelRef);
      log = started.log;
      const { runtime, note } = started;
      rec.runtime = runtime;
      const watchdog = new ProgressWatchdog(() => this.watchdogSteps);
      offWatchdog = runtime.committer?.onCommit((event) => {
        const alert = watchdog.observe(event);
        if (!alert || !rec.info.parentId || rec.controller.signal.aborted || rec.info.report) return;
        this.deliver(rec.info.parentId, this.systemEnvelope(id, rec.info.parentId, 'alert', `${id} 需要检查进展`,
          `${id} 已连续 ${alert.steps} 个已完成步骤没有新增工具结果或产出。${alert.denied ? '其中有操作被拒绝，请先检查权限拒绝原因。' : '请检查是否重复相同操作或遇到工具错误。'}可用 agents_status 查看状态，再 send_message 给它 steer，或让它 report 当前结论。`));
      });
      runtime.setPaused(rec.info.state === 'paused');
      timer = setTimeout(() => this.cancelSubtree(id, `运行超过 ${Math.round(limit / 60_000)} 分钟`), limit);
      for await (const ev of runtime.run(prompt + note, rec.controller.signal)) {
        this.deps.onAgentEvent?.(id, ev);
        if (ev.type === 'text-delta') lastText += ev.text;
        else if (ev.type === 'tool-call-start' || ev.type === 'turn-start') lastText = '';
        else if (ev.type === 'turn-end') lastReason = ev.reason;
      }
    } catch (err) {
      lastReason = 'error';
      lastText = err instanceof Error ? err.message : String(err);
    } finally {
      offWatchdog?.();
      clearTimeout(timer);
      await log?.close().catch((err: unknown) => { lastReason = 'error'; lastText = err instanceof Error ? err.message : String(err); });
      const cancelled = rec.controller.signal.aborted;
      if (!rec.info.report) {
        const status: Report['status'] = cancelled ? 'cancelled' : lastReason === 'completed' ? 'done' : 'failed';
        this.report(id, { agentId: id, status, summary: lastText.trim() || '（没有输出）', refs: [] });
      }
      const state: AgentInfo['state'] = cancelled ? 'cancelled' : rec.info.report?.status === 'failed' || lastReason === 'error' ? 'failed' : 'done';
      const { waitingFor: _waiting, ...info } = rec.info;
      rec.info = { ...info, state, endedAt: this.now() };
      this.deps.onAgentEnd?.(id);
      this.deps.onChange?.();
    }
  }

  /** 记录报告（首个有效），投递给父 agent，写黑板 /reports/<id> */
  report(id: string, report: Report): boolean {
    const rec = this.recs.get(id);
    const parentId = rec?.info.parentId;
    if (!rec || rec.info.report || !parentId) return false;
    const full = rec.worktree ? { ...report, summary: report.summary + reportWorktreeNote(id, rec.worktree) } : report;
    rec.info = { ...rec.info, report: full };
    this.board.write(`/reports/${id}`, `[${full.status}] ${full.summary}`, { author: id });
    this.deliver(parentId, this.systemEnvelope(id, parentId, 'report', `${id} ${full.status}`, full.summary, full.refs));
    rec.resolveReport(full);
    return true;
  }

  /** 按父 agent 串行化的工作区操作（合并 / 丢弃 / 派生时的基线快照）：同一工作区的补丁与快照不会交错 */
  private readonly workspaceChains = new Map<string, Promise<unknown>>();

  private serialize<T>(parentId: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.workspaceChains.get(parentId) ?? Promise.resolve()).then(fn);
    this.workspaceChains.set(parentId, next.catch(() => undefined));
    return next;
  }

  /**
   * 父 agent 合并（或丢弃）直接下级 worktree 中的改动；discard 用于 best-of-N 中落选的候选。
   * 只按父 agent 串行（不同父 agent 的工作区互不影响），且不等待仍在运行的下级（避免卡住、无法中断）。
   */
  mergeWorktree(callerId: string, childId: string, opts: { discard?: boolean } = {}): Promise<{ ok: boolean; text: string }> {
    return this.serialize(callerId, () => this.doMerge(callerId, childId, opts.discard === true));
  }

  private async doMerge(callerId: string, childId: string, discard: boolean): Promise<{ ok: boolean; text: string }> {
    const rec = this.recs.get(childId);
    if (!rec || rec.info.parentId !== callerId) return { ok: false, text: `${childId} 不是你的直接下级` };
    if (!rec.worktree || !this.deps.worktrees) {
      return { ok: false, text: rec.merged ? `${childId} 的 worktree 已经处理过了` : `${childId} 没有使用独立 worktree（与你共享工作区，改动已直接生效）` };
    }
    if (!rec.info.report) return { ok: false, text: `${childId} 还没有 report，请等它完成后再处理（await_agents）` };
    // report 之后通常只剩最后一步收尾：短暂等待；超过宽限期仍在运行（如在等它的下级）则不阻塞
    if (LIVE.has(rec.info.state) && rec.finished) await settleWithin(rec.finished, FINISH_GRACE_MS);
    if (LIVE.has(rec.info.state)) {
      return { ok: false, text: `${childId} 已 report 但仍在运行（可能在收尾或等待它的下级），请稍后再处理；可先 await_agents 或查看 agents_status` };
    }
    if (discard) {
      const files = await this.deps.worktrees.changedFiles(rec.worktree).catch(() => []);
      await this.closeWorktree(rec);
      return { ok: true, text: `已丢弃 ${childId} 的改动（${files.length} 个文件），worktree 已删除` };
    }
    const result = await this.deps.worktrees.merge(rec.worktree);
    if (result.ok) await this.closeWorktree(rec);
    return { ok: result.ok, text: formatMerge(childId, result, rec.worktree) };
  }

  private async closeWorktree(rec: Rec): Promise<void> {
    if (rec.worktree) await this.deps.worktrees?.remove(rec.worktree);
    const { worktree: _done, ...info } = rec.info;
    rec.worktree = undefined;
    rec.merged = true;
    rec.info = info;
    this.deps.onChange?.();
  }

  /** 收尾：删除没有任何改动的 worktree；有未合并改动的保留（返回其路径，供提示用户） */
  async cleanupWorktrees(): Promise<string[]> {
    const kept: string[] = [];
    for (const rec of this.recs.values()) {
      const wt = rec.worktree;
      if (!wt || !this.deps.worktrees) continue;
      const changed = await this.deps.worktrees.changedFiles(wt).catch(() => ['?']);
      if (changed.length === 0) {
        try {
          await this.deps.worktrees.remove(wt);
          rec.worktree = undefined;
          const { worktree: _removed, ...info } = rec.info;
          rec.info = info;
          continue;
        } catch { kept.push(wt.root); }
      } else kept.push(wt.root);
      await this.deps.worktrees.release?.(wt).catch(() => {});
    }
    return kept;
  }

  /**
   * 等待目标子 agent（不耗 token）。目标的报告直接随结果返回（从 inbox 中移除，避免重复投递）；
   * 其余唤醒类消息（提问、steer、非目标的报告……）让等待提前返回 'message'，由下一个 step 的 inbox 送达。
   * 每轮循环开始时 inbox 中不会残留唤醒类消息，所以等待不会空转。
   */
  async wait(parentId: string, ids: string[], mode: 'any' | 'all', opts: { timeoutMs?: number; signal: AbortSignal }): Promise<WaitResult> {
    const parent = this.recs.get(parentId);
    const targets = (ids.length ? ids : (parent?.info.children ?? [])).filter((t) => this.recs.has(t));
    const deadline = opts.timeoutMs ? this.now() + opts.timeoutMs : Number.POSITIVE_INFINITY;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = Number.isFinite(deadline) ? new Promise<void>((r) => (timer = setTimeout(r, Math.max(0, deadline - this.now())))) : new Promise<void>(() => {});
    try {
      for (;;) {
        const reports = targets.map((t) => this.recs.get(t)!.info.report).filter((r): r is Report => r !== undefined);
        const pending = targets.filter((t) => !this.recs.get(t)!.info.report);
        // 中断时不消费报告：结果不会到达模型，报告必须留在 inbox 里随下一个 step 送达
        if (opts.signal.aborted) return { reason: 'aborted', reports, pending };
        this.consumeReports(parentId, reports);
        if ((mode === 'all' && pending.length === 0) || (mode === 'any' && reports.length > 0) || targets.length === 0) return { reason: 'done', reports, pending };
        if (parent?.mailbox.hasWaking()) return { reason: 'message', reports, pending };
        if (this.now() >= deadline) return { reason: 'timeout', reports, pending };
        await Promise.race([...pending.map((t) => this.recs.get(t)!.reported), parent?.mailbox.waitForWake(opts.signal) ?? timeout, timeout]);
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** await 已直接返回的报告，不再通过 inbox 重复投递 */
  private consumeReports(parentId: string, reports: Report[]): void {
    const ids = new Set(reports.map((r) => r.agentId));
    this.recs.get(parentId)?.mailbox.remove((e) => e.kind === 'report' && ids.has(e.from));
  }

  cancelSubtree(id: string, reason = '被上级取消'): void {
    const rec = this.recs.get(id);
    if (!rec) return;
    for (const c of rec.info.children) this.cancelSubtree(c, reason);
    if (rec.info.parentId) rec.controller.abort(reason);
  }

  setPaused(id: string, paused: boolean): boolean {
    const rec = this.recs.get(id);
    if (!rec?.info.parentId || !LIVE.has(rec.info.state)) return false;
    rec.runtime?.setPaused(paused);
    rec.info = { ...rec.info, state: paused ? 'paused' : rec.info.waitingFor ? 'waiting' : 'running' };
    this.deps.onChange?.();
    return true;
  }

  /** User approval is a wait, not stalled execution. */
  setInteractionWaiting(id: string, reason?: string): void {
    const rec = this.recs.get(id);
    if (!rec || !LIVE.has(rec.info.state) || rec.info.waitingFor === reason) return;
    const { waitingFor: _previous, ...info } = rec.info;
    rec.info = { ...info, state: info.state === 'paused' ? 'paused' : reason ? 'waiting' : 'running', ...(reason ? { waitingFor: reason } : {}) };
    this.deps.onChange?.();
  }

  /** 子 agent 的边界钩子：step 前投递 inbox；想结束时若仍有活跃子 agent 则等待（不耗 token） */
  hooksFor(id: string): BoundaryHooks {
    return {
      beforeRequest: () => {
        const envs = this.recs.get(id)?.mailbox.drain() ?? [];
        return envs.length ? [{ kind: 'inject', source: 'inbox', blocks: [{ type: 'text', text: renderInbox(envs) }] }] : [];
      },
      onWouldEndTurn: () => {
        const mb = this.recs.get(id)?.mailbox;
        if (mb && mb.size > 0) return { kind: 'continue' };
        const active = this.activeChildren(id);
        const asked = this.openQuestions.get(id)?.size ?? 0;
        if ((active.length === 0 && asked === 0) || !mb) return { kind: 'end' };
        if (active.length > 0) return { kind: 'wait', reason: `等待子 agent：${active.join(', ')}`, until: mb.waitForWake() };
        // 只在等提问的回答：带超时，超时后放弃等待（避免上级空闲时无限挂起）
        const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), this.deps.questionWaitMs ?? 10 * 60_000));
        const until = Promise.race([mb.waitForWake().then(() => 'woke' as const), timeout]).then((r) => {
          if (r === 'timeout') this.openQuestions.get(id)?.clear();
        });
        return { kind: 'wait', reason: '等待上级回答提问', until };
      },
    };
  }
}
