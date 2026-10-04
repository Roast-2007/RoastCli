import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { atomicWriteJson } from '../../core/credentials.js';
import { RoastError } from '../../core/errors.js';
import { object, remoteJson } from '../http-json.js';

export interface EmbeddingsProvider { embed(texts: string[], signal?: AbortSignal): Promise<number[][]> }
function validVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 65_536 && value.every((x) => typeof x === 'number' && Number.isFinite(x)) && value.some((x) => x !== 0);
}
export class OpenAiEmbeddings implements EmbeddingsProvider {
  constructor(private readonly opts: { baseURL: string; model: string; apiKey(): string; headers?: Record<string, string>; dimensions?: number; timeoutMs?: number }) {}
  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    if (!texts.length) return [];
    const value = object(await remoteJson(this.opts.baseURL, 'embeddings', { label: 'Embeddings', headers: { Authorization: `Bearer ${this.opts.apiKey()}`, ...this.opts.headers }, signal, timeoutMs: this.opts.timeoutMs, body: { model: this.opts.model, input: texts, ...(this.opts.dimensions ? { dimensions: this.opts.dimensions } : {}) } }));
    const data = value['data'];
    if (!Array.isArray(data) || data.length !== texts.length) throw new RoastError('INVALID_REQUEST', 'Embeddings 向量数量无效');
    const ordered: number[][] = [];
    for (const raw of data) {
      const row = object(raw);
      const index = row['index'];
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= texts.length || ordered[index] || !validVector(row['embedding'])) throw new RoastError('INVALID_REQUEST', 'Embeddings 向量格式无效');
      ordered[index] = row['embedding'];
    }
    if (ordered.some((v) => v.length !== ordered[0]!.length)) throw new RoastError('INVALID_REQUEST', 'Embeddings 向量维度不一致');
    return ordered;
  }
}
function cosine(a: number[], b: number[]) {
  if (a.length !== b.length) throw new RoastError('INVALID_REQUEST', 'Embeddings 向量维度变化，请清理索引缓存');
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; aa += a[i]! ** 2; bb += b[i]! ** 2; }
  return dot / Math.sqrt(aa * bb);
}
export class VectorIndex {
  private vectors = new Map<string, number[]>();
  constructor(private readonly provider: EmbeddingsProvider, private readonly opts: { cacheFile?: string; batchSize?: number; maxChunks?: number } = {}) {
    if (opts.cacheFile) {
      try {
        const raw = object(JSON.parse(readFileSync(opts.cacheFile, 'utf8')));
        for (const [hash, vector] of Object.entries(raw)) if (/^[a-f0-9]{64}$/.test(hash) && validVector(vector)) this.vectors.set(hash, vector);
      } catch { /* Missing or damaged caches are rebuilt on demand. */ }
    }
  }
  async search(query: string, documents: { id: string; text: string }[], signal?: AbortSignal) {
    if (!documents.length) return [];
    const [q] = await this.provider.embed([query], signal);
    if (!validVector(q)) throw new RoastError('INVALID_REQUEST', 'Embeddings 查询向量无效');
    for (const [hash, vector] of this.vectors) if (vector.length !== q.length) this.vectors.delete(hash);
    const docs = documents.slice(0, this.opts.maxChunks ?? 2000).map((d) => ({ ...d, text: d.text.slice(0, 8000) })).map((d) => ({ ...d, hash: createHash('sha256').update(d.text).digest('hex') }));
    const missing = [...new Map(docs.filter((d) => !this.vectors.has(d.hash)).map((d) => [d.hash, d])).values()];
    const batchSize = this.opts.batchSize ?? 32;
    const staged = new Map<string, number[]>();
    for (let i = 0; i < missing.length; i += batchSize) {
      if (signal?.aborted) throw new RoastError('ABORTED', '检索被中断');
      const batch = missing.slice(i, i + batchSize);
      const vectors = await this.provider.embed(batch.map((d) => d.text), signal);
      if (vectors.length !== batch.length || vectors.some((v) => !validVector(v) || v.length !== q.length)) throw new RoastError('INVALID_REQUEST', 'Embeddings 文档向量无效或维度不一致');
      batch.forEach((d, j) => staged.set(d.hash, vectors[j]!));
    }
    for (const [hash, vector] of staged) this.vectors.set(hash, vector);
    const results = docs.map((d) => ({ id: d.id, score: cosine(q, this.vectors.get(d.hash)!) })).sort((a, b) => b.score - a.score);
    if (this.opts.cacheFile && staged.size) {
      // Keep a bounded cache; failure to persist must not discard valid search results.
      const entries = [...this.vectors].slice(-(this.opts.maxChunks ?? 2000) * 2);
      this.vectors = new Map(entries);
      try { atomicWriteJson(this.opts.cacheFile, Object.fromEntries(entries), true); } catch { /* Cache is optional. */ }
    }
    return results;
  }
}
