import { RoastError } from '../core/errors.js';

/** Shared bounded transport. Error bodies may contain credentials and are never echoed. */
export async function remoteJson(baseURL: string, endpoint: string, opts: { label: string; method?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number }): Promise<unknown> {
  const url = new URL(endpoint ? baseURL.replace(/\/$/, '') + '/' + endpoint.replace(/^\//, '') : baseURL);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new RoastError('CONFIG', `${opts.label} 地址必须是无内嵌凭据的 HTTP(S) URL`);
  const signal = AbortSignal.any([AbortSignal.timeout(opts.timeoutMs ?? 15_000), ...(opts.signal ? [opts.signal] : [])]);
  let response: Response;
  try {
    response = await fetch(url, { method: opts.method ?? 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', ...opts.headers }, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }), signal });
  } catch {
    throw new RoastError(opts.signal?.aborted ? 'ABORTED' : 'NETWORK', `${opts.label} 请求${opts.signal?.aborted ? '被中断' : signal.aborted ? '超时' : '失败'}`);
  }
  if (!response.ok) { await response.body?.cancel(); throw new RoastError('INVALID_REQUEST', `${opts.label} HTTP ${response.status}`, { status: response.status }); }
  if (response.status === 204) return null;
  const maxBytes = 16 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new RoastError('INVALID_REQUEST', `${opts.label} 响应过大`); }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) { await reader.cancel(); throw new Error('size'); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    if (signal.aborted) throw new RoastError(opts.signal?.aborted ? 'ABORTED' : 'NETWORK', `${opts.label} 请求${opts.signal?.aborted ? '被中断' : '超时'}`);
    throw new RoastError('INVALID_REQUEST', `${opts.label} 响应无效或超过大小上限`);
  } finally { reader.releaseLock(); }
}

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
