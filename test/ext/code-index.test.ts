import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { rmSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { Bm25Index, codeTerms } from '../../src/ext/rag/bm25.js';
import { chunkLines, CodeIndex, listSourceFiles } from '../../src/ext/rag/code-index.js';
import { CODE_INDEX_KEY, searchCodeTool } from '../../src/ext/rag/tool.js';
import { executeTool } from '../../src/tools/executor.js';
import { tempWorkspace } from '../fixtures/workspace.js';
import { makeCtx, textOf } from '../tools/helpers.js';

describe('codeTerms', () => {
  it('keeps whole identifiers and splits camelCase, PascalCase acronyms and snake_case', () => {
    expect(codeTerms('parseSkillFile')).toEqual(['parseskillfile', 'parse', 'skill', 'file']);
    expect(codeTerms('HTTPServer max_retry_count')).toEqual(['httpserver', 'http', 'server', 'max_retry_count', 'max', 'retry', 'count']);
    expect(codeTerms('登录模块 x')).toEqual(['登录', '录模', '模块']);
  });
});

describe('Bm25Index', () => {
  it('ranks documents by term rarity and frequency, and supports removal', () => {
    const idx = new Bm25Index();
    idx.add('a', ['retry', 'backoff', 'retry']);
    idx.add('b', ['retry', 'render']);
    idx.add('c', ['render', 'frame']);

    expect(idx.search(['retry', 'backoff'], 5).map((d) => d.id)).toEqual(['a', 'b']);
    expect(idx.search(['nothing'], 5)).toEqual([]);

    idx.remove('a');
    expect(idx.size).toBe(2);
    expect(idx.search(['backoff'], 5)).toEqual([]);
    idx.add('b', ['frame']);
    expect(idx.search(['retry'], 5)).toEqual([]);
  });
});

describe('chunkLines', () => {
  it('splits into overlapping 40-line windows and skips blank chunks', () => {
    const text = Array.from({ length: 75 }, (_, i) => `line ${i + 1}`).join('\n');
    expect(chunkLines('f.ts', text).map((c) => [c.startLine, c.endLine])).toEqual([
      [1, 40],
      [31, 70],
      [61, 75],
    ]);
    expect(chunkLines('f.ts', '\n\n')).toEqual([]);
  });
});

describe('CodeIndex', () => {
  function workspace() {
    const ws = tempWorkspace('roast-idx-');
    ws.file('src/net/retry.ts', 'export function retryWithBackoff(attempt: number) {\n  return Math.min(1000 * 2 ** attempt, 30000);\n}\n');
    ws.file('src/ui/render.ts', 'export function renderFrame() {\n  return "frame";\n}\n');
    ws.file('src/auth/login.ts', '// 登录模块：校验密码\nexport function login(user: string) {\n  return user;\n}\n');
    ws.file('node_modules/pkg/index.js', 'function retryWithBackoff() {}');
    ws.file('dist/bundle.js', 'function retryWithBackoff() {}');
    ws.file('pnpm-lock.yaml', 'retry: 1');
    return ws;
  }

  it('lists source files without dependencies, build output or lock files', async () => {
    const ws = workspace();
    expect((await listSourceFiles(ws.dir)).sort()).toEqual(['src/auth/login.ts', 'src/net/retry.ts', 'src/ui/render.ts']);
  });

  it('respects .gitignore inside git repositories', async () => {
    const ws = workspace();
    ws.file('.gitignore', 'src/ui/\n');
    if (spawnSync('git', ['init', '-q'], { cwd: ws.dir }).status !== 0) return;
    expect((await listSourceFiles(ws.dir)).sort()).toEqual(['.gitignore', 'src/auth/login.ts', 'src/net/retry.ts']);
  });

  it('finds code by natural language, sub-words and chinese, filtered by path', async () => {
    const ws = workspace();
    const idx = new CodeIndex(ws.dir);

    expect((await idx.search('backoff retry'))[0]?.file).toBe('src/net/retry.ts');
    expect((await idx.search('render frame'))[0]?.file).toBe('src/ui/render.ts');
    expect((await idx.search('登录'))[0]?.file).toBe('src/auth/login.ts');
    expect(await idx.search('frame', { pathPrefix: 'src/net' })).toEqual([]);
    expect(idx.stats.files).toBe(3);
  });

  it('refreshes changed, added and deleted files incrementally', async () => {
    const ws = workspace();
    const idx = new CodeIndex(ws.dir);
    await idx.search('x');

    const file = ws.file('src/ui/render.ts', 'export function paintCanvas() {}\n');
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    ws.file('src/new/websocket.ts', 'export const openWebsocket = () => 1;\n');
    rmSync(path.join(ws.dir, 'src/auth/login.ts'));

    expect(await idx.search('frame')).toEqual([]);
    expect((await idx.search('paint canvas'))[0]?.file).toBe('src/ui/render.ts');
    expect((await idx.search('websocket'))[0]?.file).toBe('src/new/websocket.ts');
    expect(await idx.search('登录')).toEqual([]);
  });

  it('applies the path filter before ranking so in-scope matches are not crowded out', async () => {
    const ws = tempWorkspace('roast-idx-');
    for (let i = 0; i < 20; i++) ws.file(`top/f${i}.ts`, 'export const widget = widget + widget;\n');
    ws.file('sub/deep.ts', 'export const widget = 1;\n');
    const hits = await new CodeIndex(ws.dir).search('widget', { pathPrefix: 'sub', limit: 1 });
    expect(hits.map((h) => h.file)).toEqual(['sub/deep.ts']);
  });

  it('stops waiting when the signal aborts', async () => {
    const ws = workspace();
    const ac = new AbortController();
    ac.abort();
    await expect(new CodeIndex(ws.dir).search('retry', { signal: ac.signal })).rejects.toThrow('检索被中断');
  });

  it('returns RetrievedChunk entries for the RAG seam', async () => {
    const ws = workspace();
    const chunks = await new CodeIndex(ws.dir).retrieve('backoff', { limit: 1 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.source).toBe('src/net/retry.ts:1-4');
  });
});

describe('search_code tool', () => {
  it('renders numbered snippets, or a hint when nothing matches', async () => {
    const ws = tempWorkspace('roast-idx-');
    ws.file('a.ts', 'const x = 1;\nexport function computeChecksum() {}\n');
    const ctx = makeCtx(ws.dir);
    ctx.services.set(CODE_INDEX_KEY, new CodeIndex(ws.dir));

    const hit = textOf(await executeTool(searchCodeTool, { query: 'checksum' }, ctx));
    expect(hit).toContain('── a.ts:1-');
    expect(hit).toContain('    2  export function computeChecksum() {}');

    expect(textOf(await executeTool(searchCodeTool, { query: 'zebra' }, ctx))).toContain('没有找到相关代码');
  });

  it('errors without an index service', async () => {
    expect((await executeTool(searchCodeTool, { query: 'x' }, makeCtx(tempWorkspace().dir))).isError).toBe(true);
  });
});
