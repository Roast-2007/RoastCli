/**
 * Committer：状态变更的唯一入口。commit(ev) = 先写日志（分配 seq/agentId），
 * 再用与投影相同的 reducer 更新内存状态。实时运行与 resume 走同一条代码路径，
 * 从结构上保证"模型可见 ⟺ 已落日志"。
 */
import type { Message } from '../core/types.js';
import type { SessionEvent, SessionEventBody } from '../session/events.js';
import { applyHistory, initialHistory, type HistoryState } from '../session/history.js';
import type { RunLogWriter } from '../session/log-writer.js';

export type CommitListener = (ev: SessionEvent) => void;

export class Committer {
  private history: HistoryState;
  private readonly listeners = new Set<CommitListener>();

  constructor(
    private readonly log: RunLogWriter,
    initial: HistoryState = initialHistory(),
  ) {
    this.history = initial;
  }

  commit(body: SessionEventBody): SessionEvent {
    const ev = this.log.append(body);
    this.history = applyHistory(this.history, ev);
    for (const l of this.listeners) l(ev);
    return ev;
  }

  get state(): HistoryState {
    return this.history;
  }

  messages(): readonly Message[] {
    return this.history.messages;
  }

  onCommit(listener: CommitListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  flush(): void {
    this.log.flush();
  }
}
