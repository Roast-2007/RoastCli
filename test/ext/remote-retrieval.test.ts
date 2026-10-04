import { afterEach, describe, expect, it, vi } from 'vitest';
import { Mem0Provider } from '../../src/ext/memory/mem0.js';
import { OpenAiEmbeddings, VectorIndex } from '../../src/ext/rag/embeddings.js';
import { CodeIndex } from '../../src/ext/rag/code-index.js';
import { tempWorkspace } from '../fixtures/workspace.js';
import path from 'node:path';

afterEach(() => vi.unstubAllGlobals());
describe('Mem0 project memory', () => {
  it('returns false for a missing memory and interrupts an in-flight search', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 })).mockImplementationOnce((_url, opts) => new Promise((_resolve, reject) => opts.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));
    vi.stubGlobal('fetch', fetcher);
    const memory = new Mem0Provider({ baseURL: 'https://memory.example', projectId: 'project', apiKey: () => 'secret' });
    expect(await memory.forget('missing')).toBe(false);
    const controller = new AbortController();
    const pending = memory.recall('fact', { signal: controller.signal }); controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
  });
  it('uses project filters, synchronous exact facts, metadata and safe deletion', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ results: [{ id: 'id/a', memory: 'use tabs', created_at: 'today' }] }))
      .mockResolvedValueOnce(Response.json({ results: [{ id: 'id/a', memory: 'use tabs', metadata: { tags: ['style'] } }] }))
      .mockResolvedValueOnce(Response.json({ id: 'id/a', memory: 'use tabs', user_id: 'project' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetcher);
    const memory = new Mem0Provider({ baseURL: 'https://memory.example', projectId: 'project', apiKey: () => 'secret' });
    expect(await memory.store({ content: 'use tabs', tags: ['style'] })).toMatchObject({ id: 'id/a', content: 'use tabs' });
    const payload = JSON.parse(fetcher.mock.calls[0]![1].body);
    expect(payload).toMatchObject({ user_id: 'project', infer: false, async_mode: false, metadata: { tags: ['style'], roast_project: 'project' } });
    expect(await memory.recall('indentation')).toHaveLength(1);
    expect(JSON.parse(fetcher.mock.calls[1]![1].body).filters).toEqual({ user_id: 'project' });
    expect(await memory.forget('id/a')).toBe(true);
    expect(fetcher.mock.calls[3]![0].toString()).toContain('/v1/memories/id%2Fa/');
  });
  it('does not delete another project or report an async submission as a stored fact', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ id: 'x', user_id: 'other', memory: 'fact' }))
      .mockResolvedValueOnce(Response.json({ request_id: 'pending', status: 'PENDING' }));
    vi.stubGlobal('fetch', fetcher);
    const memory = new Mem0Provider({ baseURL: 'https://memory.example', projectId: 'project', apiKey: () => 'secret' });
    expect(await memory.forget('x')).toBe(false);
    await expect(memory.store({ content: 'fact' })).rejects.toThrow('尚未返回记忆');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
describe('embeddings and vectors', () => {
  it('hybrid code search supports semantics, scoped paths, and an explicit lexical fallback', async () => {
    const ws = tempWorkspace();
    ws.file('src/auth.ts', 'export function authenticate() { return true; }');
    ws.file('other/color.ts', 'export function color() { return "blue"; }');
    const embed = vi.fn(async (texts: string[]) => texts.map((text) => text.includes('sign in') || text.includes('authenticate') ? [1, 0] : [0, 1]));
    const index = new CodeIndex(ws.dir, new VectorIndex({ embed }));
    expect((await index.search('sign in'))[0]?.file).toBe('src/auth.ts');
    const scoped = await index.search('color', { pathPrefix: 'other' });
    expect(scoped.every((hit) => hit.file.startsWith('other/'))).toBe(true);
    embed.mockRejectedValue(new Error('offline'));
    expect((await index.search('authenticate'))[0]?.file).toBe('src/auth.ts');
    expect(index.warning).toContain('回退 BM25');
  });
  it('reorders indexed results and rejects malformed vectors', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }))
      .mockResolvedValueOnce(Response.json({ data: [{ index: 0, embedding: [0, 0] }] }));
    vi.stubGlobal('fetch', fetcher);
    const embeddings = new OpenAiEmbeddings({ baseURL: 'https://embed.example/v1', model: 'embedding', apiKey: () => 'secret', headers: { 'X-Tenant': 'test' } });
    expect(await embeddings.embed(['first', 'second'])).toEqual([[1, 0], [0, 1]]);
    expect(fetcher.mock.calls[0]![1].headers).toMatchObject({ 'X-Tenant': 'test', Authorization: 'Bearer secret' });
    await expect(embeddings.embed(['bad'])).rejects.toThrow('向量');
  });
  it('reuses persisted vectors and rebuilds them when the provider dimensions change', async () => {
    const cacheFile = path.join(tempWorkspace().dir, 'vectors.json');
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));
    const docs = [{ id: 'a', text: 'unchanged' }];
    await new VectorIndex({ embed }, { cacheFile }).search('query', docs);
    embed.mockClear();
    await new VectorIndex({ embed }, { cacheFile }).search('query', docs);
    expect(embed).toHaveBeenCalledTimes(1);
    const changed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0]));
    expect(await new VectorIndex({ embed: changed }, { cacheFile }).search('query', docs)).toEqual([{ id: 'a', score: 1 }]);
    expect(changed).toHaveBeenCalledTimes(2);
  });
  it('finds semantic matches with no shared words, caches unchanged chunks and drops deleted ones', async () => {
    const embed = vi.fn(async (texts: string[]) => texts.map((text) => text.includes('sign in') || text.includes('authenticate') ? [1, 0] : [0, 1]));
    const vectors = new VectorIndex({ embed });
    const docs = [{ id: 'auth', text: 'function authenticate() {}' }, { id: 'color', text: 'function blue() {}' }];
    expect((await vectors.search('sign in', docs))[0]?.id).toBe('auth');
    embed.mockClear();
    await vectors.search('sign in', docs);
    expect(embed).toHaveBeenCalledWith(['sign in'], undefined);
    expect((await vectors.search('sign in', docs.slice(1))).every((x) => x.id !== 'auth')).toBe(true);
  });
  it('redacts server errors and rejects redirects instead of forwarding credentials', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('secret: server error', { status: 401 }));
    vi.stubGlobal('fetch', fetcher);
    const embeddings = new OpenAiEmbeddings({ baseURL: 'https://embed.example/v1', model: 'embedding', apiKey: () => 'secret' });
    await expect(embeddings.embed(['text'])).rejects.toThrow('HTTP 401');
    await expect(embeddings.embed(['text'])).rejects.not.toThrow('secret');
    expect(fetcher.mock.calls[0]![1].redirect).toBe('error');
  });
});
