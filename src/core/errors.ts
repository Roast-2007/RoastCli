/**
 * 错误 taxonomy：所有可预期错误归一化为 RoastError + 稳定 code。
 * 策略层（重试、审批、UI 展示）按 code 路由，不做字符串匹配。
 */

export type ErrorCode =
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'QUOTA_EXCEEDED'
  | 'CONTEXT_WINDOW_EXCEEDED'
  | 'INVALID_REQUEST'
  | 'SERVER'
  | 'NETWORK'
  | 'MISSING_CREDENTIAL'
  | 'NO_ADAPTER'
  | 'UNKNOWN_TOOL'
  | 'TOOL_ARGS'
  | 'TOOL_EXECUTION'
  | 'CONFIG'
  | 'UNTRUSTED_CONFIG'
  | 'ABORTED'
  | 'UNKNOWN';

export class RoastError extends Error {
  readonly code: ErrorCode;
  /** 是否值得自动重试 */
  readonly retryable: boolean;
  readonly status?: number;
  /** 服务端建议的重试等待（来自 retry-after 头），毫秒 */
  readonly retryAfterMs?: number;

  constructor(
    code: ErrorCode,
    message: string,
    opts?: { retryable?: boolean; status?: number; retryAfterMs?: number; cause?: unknown },
  ) {
    super(message, { cause: opts?.cause });
    this.name = 'RoastError';
    this.code = code;
    this.retryable = opts?.retryable ?? false;
    if (opts?.status !== undefined) this.status = opts.status;
    if (opts?.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      status: this.status,
      ...(this.retryAfterMs !== undefined ? { retryAfterMs: this.retryAfterMs } : {}),
    };
  }
}

/** 把 HTTP 状态码（+响应文本线索）归一化为稳定 code */
export function httpErrorCode(status: number, bodyText = ''): ErrorCode {
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 429) return 'RATE_LIMIT';
  if (status === 402) return 'QUOTA_EXCEEDED';
  if (status === 400 || status === 404 || status === 422) {
    const t = bodyText.toLowerCase();
    if (t.includes('context') && (t.includes('length') || t.includes('window') || t.includes('too long'))) {
      return 'CONTEXT_WINDOW_EXCEEDED';
    }
    if (t.includes('insufficient') && t.includes('balance')) return 'QUOTA_EXCEEDED';
    return 'INVALID_REQUEST';
  }
  if (status === 413) return 'CONTEXT_WINDOW_EXCEEDED';
  if (status >= 500) return 'SERVER';
  return 'UNKNOWN';
}

const NUMERIC = /^\d+(\.\d+)?$/;

/**
 * 解析 retry-after-ms / retry-after（秒数或 HTTP 日期）为毫秒；缺失或非法返回 undefined。
 */
export function parseRetryAfter(headers: Headers, now: number = Date.now()): number | undefined {
  const ms = headers.get('retry-after-ms');
  if (ms !== null && NUMERIC.test(ms.trim())) return Math.round(Number(ms));
  const raw = headers.get('retry-after');
  if (raw === null) return undefined;
  const v = raw.trim();
  if (NUMERIC.test(v)) return Math.round(Number(v) * 1000);
  const date = Date.parse(v);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

export function isRetryableCode(code: ErrorCode): boolean {
  return code === 'RATE_LIMIT' || code === 'SERVER' || code === 'NETWORK';
}

/** 把任意 thrown 值归一化为 RoastError */
export function asRoastError(err: unknown): RoastError {
  if (err instanceof RoastError) return err;
  if (err instanceof DOMException && err.name === 'AbortError') {
    return new RoastError('ABORTED', '请求被中断', { cause: err });
  }
  if (err instanceof Error) {
    if (err.name === 'AbortError') return new RoastError('ABORTED', '请求被中断', { cause: err });
    // fetch 网络层错误（不把普通编程错误的 TypeError 当作可重试网络错误）
    if (isFetchLayerError(err)) {
      return new RoastError('NETWORK', `网络错误: ${err.message}`, { retryable: true, cause: err });
    }
    return new RoastError('UNKNOWN', err.message, { cause: err });
  }
  return new RoastError('UNKNOWN', String(err));
}

/** undici fetch 的网络失败：TypeError('fetch failed') 或带 errno 风格 code 的 cause；以及 node-fetch 的 FetchError */
function isFetchLayerError(err: Error): boolean {
  if (err.name === 'FetchError') return true;
  if (err.name !== 'TypeError') return false;
  if (err.message === 'fetch failed' || err.message === 'terminated') return true;
  const cause = (err as { cause?: unknown }).cause;
  return typeof cause === 'object' && cause !== null && typeof (cause as { code?: unknown }).code === 'string';
}
