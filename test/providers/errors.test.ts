/**
 * httpErrorCode / isRetryableCode / asRoastError 归一化测试。
 */
import { describe, expect, it } from 'vitest';
import { asRoastError, httpErrorCode, isRetryableCode, RoastError } from '../../src/core/errors.js';

describe('httpErrorCode', () => {
  it('401/403 → AUTH', () => {
    expect(httpErrorCode(401)).toBe('AUTH');
    expect(httpErrorCode(403)).toBe('AUTH');
  });

  it('429 → RATE_LIMIT；402 → QUOTA_EXCEEDED', () => {
    expect(httpErrorCode(429)).toBe('RATE_LIMIT');
    expect(httpErrorCode(402)).toBe('QUOTA_EXCEEDED');
  });

  it('400 按 body 文本细分', () => {
    expect(httpErrorCode(400, 'This model maximum context length is 65536')).toBe('CONTEXT_WINDOW_EXCEEDED');
    expect(httpErrorCode(400, 'context window too long')).toBe('CONTEXT_WINDOW_EXCEEDED');
    expect(httpErrorCode(400, 'Insufficient Balance')).toBe('QUOTA_EXCEEDED');
    expect(httpErrorCode(400, 'bad request')).toBe('INVALID_REQUEST');
  });

  it('404/422 → INVALID_REQUEST；413 → CONTEXT_WINDOW_EXCEEDED；5xx → SERVER', () => {
    expect(httpErrorCode(404)).toBe('INVALID_REQUEST');
    expect(httpErrorCode(422)).toBe('INVALID_REQUEST');
    expect(httpErrorCode(413)).toBe('CONTEXT_WINDOW_EXCEEDED');
    expect(httpErrorCode(500)).toBe('SERVER');
    expect(httpErrorCode(503)).toBe('SERVER');
  });

  it('其他 → UNKNOWN', () => {
    expect(httpErrorCode(302)).toBe('UNKNOWN');
  });
});

describe('isRetryableCode', () => {
  it('RATE_LIMIT / SERVER / NETWORK 可重试', () => {
    expect(isRetryableCode('RATE_LIMIT')).toBe(true);
    expect(isRetryableCode('SERVER')).toBe(true);
    expect(isRetryableCode('NETWORK')).toBe(true);
    expect(isRetryableCode('AUTH')).toBe(false);
    expect(isRetryableCode('INVALID_REQUEST')).toBe(false);
  });
});

describe('asRoastError', () => {
  it('RoastError 原样透传', () => {
    const e = new RoastError('AUTH', 'x');
    expect(asRoastError(e)).toBe(e);
  });

  it('AbortError → ABORTED', () => {
    expect(asRoastError(new DOMException('aborted', 'AbortError')).code).toBe('ABORTED');
  });

  it('TypeError（fetch 网络层）→ NETWORK 可重试', () => {
    const e = asRoastError(new TypeError('fetch failed'));
    expect(e.code).toBe('NETWORK');
    expect(e.retryable).toBe(true);
    const withCause = asRoastError(Object.assign(new TypeError('terminated'), { cause: { code: 'ECONNRESET' } }));
    expect(withCause.code).toBe('NETWORK');
  });

  it('普通编程错误的 TypeError 不当作可重试网络错误', () => {
    const e = asRoastError(new TypeError('x.stream is not a function'));
    expect(e.code).toBe('UNKNOWN');
    expect(e.retryable).toBe(false);
  });
});
