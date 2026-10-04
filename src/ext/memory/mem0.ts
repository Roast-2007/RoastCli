import type { MemoryFact, MemoryProvider } from '../memory.js';
import { remoteJson, object } from '../http-json.js';
import { RoastError } from '../../core/errors.js';

export interface Mem0Options { baseURL: string; projectId: string; apiKey(): string | undefined; mode?: 'platform' | 'self-hosted'; apiVersion?: 'v2' | 'v3'; timeoutMs?: number }
export class Mem0Provider implements MemoryProvider {
  constructor(private readonly opts: Mem0Options) {}
  private get local() { return this.opts.mode === 'self-hosted'; }
  private get version() { return this.opts.apiVersion ?? 'v3'; }
  private request(endpoint: string, method = 'POST', body?: unknown, signal?: AbortSignal) {
    const key = this.opts.apiKey();
    if (!key && !this.local) throw new RoastError('MISSING_CREDENTIAL', 'Mem0 缺少凭据，请设置 memory.apiKeyEnv');
    return remoteJson(this.opts.baseURL, endpoint, { label: 'Mem0', method, body, headers: key ? this.local ? { 'X-API-Key': key } : { Authorization: `Token ${key}` } : {}, timeoutMs: this.opts.timeoutMs, signal });
  }
  private facts(value: unknown): MemoryFact[] {
    const rows = Array.isArray(value) ? value : object(value)['results'];
    if (!Array.isArray(rows)) return [];
    return rows.flatMap((value) => {
      const row = object(value);
      const metadata = object(row['metadata']);
      if (typeof row['id'] !== 'string' || typeof row['memory'] !== 'string') return [];
      return [{ id: row['id'], content: row['memory'], createdAt: typeof row['created_at'] === 'string' ? row['created_at'] : '', ...(Array.isArray(metadata['tags']) ? { tags: metadata['tags'].filter((x): x is string => typeof x === 'string') } : {}), ...(typeof metadata['source'] === 'string' ? { source: metadata['source'] } : {}) }];
    });
  }
  async store(fact: Omit<MemoryFact, 'id' | 'createdAt'>, opts: { signal?: AbortSignal } = {}): Promise<MemoryFact> {
    const value = await this.request(this.local ? 'memories' : this.version === 'v3' ? 'v3/memories/add/' : 'v1/memories/', 'POST', { messages: [{ role: 'user', content: fact.content }], user_id: this.opts.projectId, infer: false, ...(!this.local ? { async_mode: false } : {}), metadata: { ...fact, roast_project: this.opts.projectId } }, opts.signal);
    const rows = object(value)['results'];
    const row = object(Array.isArray(rows) ? rows.find((r) => object(r)['event'] !== 'DELETE') : value);
    if (typeof row['id'] !== 'string') throw new RoastError('INVALID_REQUEST', 'Mem0 尚未返回记忆 id，保存未确认');
    return { ...fact, id: row['id'], createdAt: typeof row['created_at'] === 'string' ? row['created_at'] : new Date().toISOString() };
  }
  async list(opts: { limit?: number; signal?: AbortSignal } = {}): Promise<MemoryFact[]> {
    const limit = Math.max(1, Math.min(100, opts.limit ?? 50));
    const value = this.local ? await this.request(`memories?user_id=${encodeURIComponent(this.opts.projectId)}&top_k=${limit}`, 'GET', undefined, opts.signal) : await this.request(`${this.version}/memories/?page=1&page_size=${limit}`, 'POST', { filters: { user_id: this.opts.projectId } }, opts.signal);
    return this.facts(value).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }
  async recall(query: string, opts: { limit?: number; signal?: AbortSignal } = {}): Promise<MemoryFact[]> {
    if (!query.trim()) return [];
    const limit = Math.max(1, Math.min(100, opts.limit ?? 8));
    return this.facts(await this.request(this.local ? 'search' : `${this.version}/memories/search/`, 'POST', { query, filters: { user_id: this.opts.projectId }, ...(this.local ? { limit } : { top_k: limit }) }, opts.signal)).slice(0, limit);
  }
  async forget(id: string, opts: { signal?: AbortSignal } = {}): Promise<boolean> {
    const endpoint = this.local ? `memories/${encodeURIComponent(id)}` : `v1/memories/${encodeURIComponent(id)}/`;
    let record: Record<string, unknown>;
    try { record = object(await this.request(endpoint, 'GET', undefined, opts.signal)); }
    catch (err) { if (err instanceof RoastError && err.status === 404) return false; throw err; }
    // IDs are globally addressable. Verify project ownership before sending DELETE.
    if (record['user_id'] !== this.opts.projectId && object(record['metadata'])['roast_project'] !== this.opts.projectId) return false;
    await this.request(endpoint, 'DELETE', undefined, opts.signal);
    return true;
  }
}
