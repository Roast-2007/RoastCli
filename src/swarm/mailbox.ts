/**
 * Mailbox：每个 agent 一个收件箱。
 * - 在 step 边界被整体取出，渲染成 <inbox> 附件注入上下文（落日志）
 * - question / answer / steer / alert / report 会唤醒等待中的 agent；info 不唤醒
 */
import { formatAddress, WAKE_KINDS, type Envelope } from './types.js';

export class Mailbox {
  private queue: Envelope[] = [];
  private waiters: (() => void)[] = [];

  enqueue(e: Envelope): void {
    this.queue.push(e);
    if (WAKE_KINDS.has(e.kind)) this.wake();
  }

  get size(): number {
    return this.queue.length;
  }

  hasWaking(): boolean {
    return this.queue.some((e) => WAKE_KINDS.has(e.kind));
  }

  drain(): Envelope[] {
    const out = this.queue;
    this.queue = [];
    return out;
  }

  /** 查看但不取出 */
  drainPeek(): readonly Envelope[] {
    return this.queue;
  }

  /** 移除满足条件的消息（如 await 已直接返回的报告，避免重复投递） */
  remove(pred: (e: Envelope) => boolean): void {
    this.queue = this.queue.filter((e) => !pred(e));
  }

  /** 有唤醒类消息时 resolve（已有则立即）；signal 中断时也 resolve */
  waitForWake(signal?: AbortSignal): Promise<void> {
    if (this.hasWaking() || signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        signal?.removeEventListener('abort', done);
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve();
      };
      this.waiters.push(done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  private wake(): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }
}

/** 渲染 inbox 附件（模型可见） */
export function renderInbox(envelopes: Envelope[]): string {
  const items = envelopes.map((e) => {
    const refs = e.refs.length ? `\n引用：${e.refs.join(', ')}` : '';
    const reply = e.replyTo ? `（回复 ${e.replyTo}）` : '';
    return `[${e.kind}] 来自 ${e.from} → ${formatAddress(e.to)}${reply}｜${e.subject}｜消息 id ${e.id}\n${e.body}${refs}`;
  });
  return `<inbox>\n${items.join('\n\n')}\n</inbox>`;
}
