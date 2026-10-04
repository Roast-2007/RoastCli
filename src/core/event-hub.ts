/**
 * EventHub：多 agent 事件总线（面向 UI / 监控），按时间窗合批投递（默认 ~30Hz），
 * 避免高频流式 delta 逐条触发渲染。订阅者按过滤器各自收取批次；订阅者抛错被隔离。
 */

export interface HubEvent<T> {
  agentId: string;
  event: T;
}

export type HubFilter<T> = ((e: HubEvent<T>) => boolean) | null;
export type Unsubscribe = () => void;

interface Subscriber<T> {
  filter: HubFilter<T>;
  cb: (batch: HubEvent<T>[]) => void;
  pending: HubEvent<T>[];
}

export interface EventHubOptions {
  /** 合批窗口毫秒数，默认 33（≈30fps） */
  batchMs?: number;
}

export class EventHub<T> {
  private readonly subscribers = new Set<Subscriber<T>>();
  private readonly batchMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: EventHubOptions = {}) {
    this.batchMs = opts.batchMs ?? 33;
  }

  publish(agentId: string, event: T): void {
    const e: HubEvent<T> = { agentId, event };
    let queued = false;
    for (const s of this.subscribers) {
      if (s.filter && !s.filter(e)) continue;
      s.pending.push(e);
      queued = true;
    }
    if (queued && this.timer === null) {
      this.timer = setTimeout(() => this.flush(), this.batchMs);
    }
  }

  subscribe(filter: HubFilter<T>, cb: (batch: HubEvent<T>[]) => void): Unsubscribe {
    const sub: Subscriber<T> = { filter, cb, pending: [] };
    this.subscribers.add(sub);
    return () => {
      this.subscribers.delete(sub);
    };
  }

  /** 立即投递所有待发批次 */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const s of this.subscribers) {
      if (s.pending.length === 0) continue;
      const batch = s.pending;
      s.pending = [];
      try {
        s.cb(batch);
      } catch {
        // 订阅者错误隔离：一个面板崩溃不影响其他订阅者
      }
    }
  }
}
