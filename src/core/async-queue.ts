/**
 * 极简异步队列：push 生产、close 结束、异步迭代消费。
 * close(err) 让消费者在缓冲耗尽后抛出 err（生产方失败时不让消费者永久等待）。
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiting: (() => void) | null = null;
  private closed = false;
  private error: unknown = undefined;
  private consuming = false;

  push(item: T): void {
    if (this.closed) return;
    this.buffer.push(item);
    this.wake();
  }

  close(err?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.error = err;
    this.wake();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private wake(): void {
    const w = this.waiting;
    this.waiting = null;
    w?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.consuming) throw new Error('AsyncQueue 仅支持单消费者');
    this.consuming = true;
    try {
      yield* this.consume();
    } finally {
      this.consuming = false;
    }
  }

  private async *consume(): AsyncGenerator<T> {
    while (true) {
      while (this.buffer.length > 0) yield this.buffer.shift() as T;
      if (this.closed) {
        if (this.error !== undefined) throw this.error;
        return;
      }
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
    }
  }
}
