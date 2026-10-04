import { describe, expect, it } from 'vitest';
import { RoastError, parseRetryAfter } from '../../src/core/errors.js';
import { DEFAULT_RETRY, retryDelay } from '../../src/agent/retry.js';

const noJitter = () => 0.5; // jitter 因子居中 → 无偏移

describe('retryDelay', () => {
  it('不可重试错误返回 null', () => {
    expect(retryDelay(1, new RoastError('AUTH', 'x'), DEFAULT_RETRY, noJitter)).toBeNull();
  });

  it('可重试错误指数退避并封顶', () => {
    const err = new RoastError('SERVER', 'x', { retryable: true });
    expect(retryDelay(1, err, DEFAULT_RETRY, noJitter)).toBe(1000);
    expect(retryDelay(2, err, DEFAULT_RETRY, noJitter)).toBe(2000);
    expect(retryDelay(3, err, DEFAULT_RETRY, noJitter)).toBe(4000);
    const capped = retryDelay(4, err, { ...DEFAULT_RETRY, maxDelayMs: 3000 }, noJitter);
    expect(capped).toBe(3000);
  });

  it('超过 maxRetries 返回 null', () => {
    const err = new RoastError('RATE_LIMIT', 'x', { retryable: true });
    expect(retryDelay(DEFAULT_RETRY.maxRetries + 1, err, DEFAULT_RETRY, noJitter)).toBeNull();
  });

  it('优先遵守 retryAfterMs', () => {
    const err = new RoastError('RATE_LIMIT', 'x', { retryable: true, retryAfterMs: 7000 });
    expect(retryDelay(1, err, DEFAULT_RETRY, noJitter)).toBe(7000);
  });

  it('jitter 在 ±jitter 比例内', () => {
    const err = new RoastError('SERVER', 'x', { retryable: true });
    expect(retryDelay(1, err, DEFAULT_RETRY, () => 0)).toBe(800);
    expect(retryDelay(1, err, DEFAULT_RETRY, () => 1)).toBe(1200);
  });
});

describe('parseRetryAfter', () => {
  it('秒数', () => {
    expect(parseRetryAfter(new Headers({ 'retry-after': '3' }))).toBe(3000);
  });
  it('retry-after-ms 优先', () => {
    expect(parseRetryAfter(new Headers({ 'retry-after-ms': '250', 'retry-after': '3' }))).toBe(250);
  });
  it('HTTP 日期', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter(new Headers({ 'retry-after': 'Thu, 01 Jan 2026 00:00:05 GMT' }), now)).toBe(5000);
  });
  it('缺失或非法返回 undefined', () => {
    expect(parseRetryAfter(new Headers())).toBeUndefined();
    expect(parseRetryAfter(new Headers({ 'retry-after': 'soon' }))).toBeUndefined();
  });
});
