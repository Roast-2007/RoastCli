import { asRoastError, RoastError } from '../core/errors.js';
import type { ProviderAdapter } from './adapter.js';
import type { GenerateOptions, StreamChunk } from '../core/types.js';

type Release = (error?: RoastError, success?: boolean) => void;
interface Waiter { resolve(release: Release): void; reject(error: RoastError): void; signal?: AbortSignal; abort(): void }

/** FIFO concurrency shared by a profile, with additive increase / multiplicative decrease. */
export class ProviderLimiter {
  private limit: number;
  private active = 0;
  private successes = 0;
  private cooldownUntil = 0;
  private queue: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly maximum = 8) { this.limit = Math.min(4, Math.max(1, maximum)); }
  get stats() { return { limit: this.limit, active: this.active, queued: this.queue.length }; }

  acquire(signal?: AbortSignal): Promise<Release> {
    if (signal?.aborted) return Promise.reject(new RoastError('ABORTED', '等待模型请求被中断'));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal, abort: () => {
        this.queue = this.queue.filter((entry) => entry !== waiter);
        signal?.removeEventListener('abort', waiter.abort);
        reject(new RoastError('ABORTED', '等待模型请求被中断'));
        this.drain();
      } };
      this.queue.push(waiter);
      signal?.addEventListener('abort', waiter.abort, { once: true });
      this.drain();
    });
  }

  private drain(): void {
    clearTimeout(this.timer); this.timer = undefined;
    if (!this.queue.length || this.active >= this.limit) return;
    const remaining = this.cooldownUntil - Date.now();
    if (remaining > 0) {
      this.timer = setTimeout(() => { this.timer = undefined; this.drain(); }, Math.min(remaining, 2_147_483_647));
      return;
    }
    while (this.active < this.limit && this.queue.length) {
      const waiter = this.queue.shift()!;
      waiter.signal?.removeEventListener('abort', waiter.abort);
      this.active++;
      let released = false;
      waiter.resolve((error, success = false) => {
        if (released) return;
        released = true; this.active--;
        if (error?.code === 'RATE_LIMIT') {
          this.limit = Math.max(1, Math.floor(this.limit / 2));
          this.successes = 0;
          this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + (error.retryAfterMs ?? 1000));
        } else if (success) {
          if (++this.successes >= 10) { this.limit = Math.min(this.maximum, this.limit + 1); this.successes = 0; }
        } else this.successes = 0;
        this.drain();
      });
    }
  }
}

/** The permit covers only a provider stream, so tools and parent waits cannot hold it. */
export function scheduledAdapter(adapter: ProviderAdapter, limiter = new ProviderLimiter()): ProviderAdapter {
  return {
    driver: adapter.driver,
    ...(adapter.listModels ? { listModels: () => adapter.listModels!() } : {}),
    ...(adapter.resolveModel ? { resolveModel: (model: string) => adapter.resolveModel!(model) } : {}),
    async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
      let release: Release | undefined;
      let error: RoastError | undefined;
      let success = false;
      try {
        release = await limiter.acquire(options.signal);
        // A queued signal may abort between granting the permit and resuming this generator.
        if (options.signal?.aborted) throw new RoastError('ABORTED', '模型请求被中断');
        for await (const chunk of adapter.stream(options)) {
          if (chunk.type === 'finish') { error = chunk.error; success = chunk.reason !== 'error' && chunk.reason !== 'aborted'; }
          yield chunk;
        }
      } catch (thrown) {
        error = asRoastError(thrown);
        yield { type: 'finish', reason: error.code === 'ABORTED' ? 'aborted' : 'error', error };
      } finally { release?.(error, success); }
    },
  };
}
