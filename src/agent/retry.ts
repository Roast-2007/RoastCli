/**
 * 重试策略：可重试错误（RATE_LIMIT / SERVER / NETWORK）指数退避 + 抖动，
 * 优先遵守服务端 retry-after。时钟可注入，测试不真睡。
 */
import type { RoastError } from '../core/errors.js';

export interface Clock {
  now(): number;
  /** 可被 signal 打断；打断时 resolve（调用方自行检查 signal.aborted） */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      }
      signal?.addEventListener('abort', done, { once: true });
    }),
};

export interface RetryPolicy {
  /** 最多重试次数（不含首次请求） */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** 抖动比例：延迟在 [1-jitter, 1+jitter] 区间浮动 */
  jitter: number;
  /** retry-after 的采信上限，防止服务端给出离谱的等待 */
  maxRetryAfterMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxRetries: 4,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  jitter: 0.2,
  maxRetryAfterMs: 120_000,
};

/** 第 attempt 次重试（1-based）前应等待的毫秒数；不应重试时返回 null */
export function retryDelay(
  attempt: number,
  err: RoastError,
  policy: RetryPolicy = DEFAULT_RETRY,
  random: () => number = Math.random,
): number | null {
  if (!err.retryable || attempt > policy.maxRetries) return null;
  if (err.retryAfterMs !== undefined) return Math.min(err.retryAfterMs, policy.maxRetryAfterMs);
  const exp = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
  const factor = 1 + policy.jitter * (random() * 2 - 1);
  return Math.min(Math.round(exp * factor), policy.maxDelayMs);
}
