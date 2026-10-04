/**
 * 代码库索引：按行窗口分块建 BM25 索引；首次检索时构建，之后每次检索前按文件 mtime/size 增量刷新。
 * 文件清单：git 仓库用 `git ls-files`（尊重 .gitignore），否则遍历目录并忽略常见产物目录。
 * 只作为 search_code 工具供模型主动调用；不自动注入上下文（会破坏前缀缓存）。
 */
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { RoastError } from '../../core/errors.js';
import { walkFiles } from '../../tools/search/walk.js';
import type { RetrievalProvider, RetrievedChunk } from '../rag.js';
import { Bm25Index, codeTerms } from './bm25.js';
import type { VectorIndex } from './embeddings.js';

const CHUNK_LINES = 40;
const CHUNK_STRIDE = 30;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 20_000;
const GIT_TIMEOUT_MS = 10_000;
/** 每批并发处理的文件数（批与批之间让出事件循环） */
const REFRESH_BATCH = 32;

const SKIP_DIRS = ['node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'logs', '.roast', '.next', 'target', 'vendor', '__pycache__'];
const SKIP_FILE = /(\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|eot|mp[34]|exe|dll|so|dylib|map|lock)$)|(\.min\.(js|css)$)|(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/i;

export interface CodeChunk {
  file: string;
  startLine: number;
  endLine: number;
  text: string;
}

export interface CodeHit extends CodeChunk {
  score: number;
}

interface FileEntry {
  mtimeMs: number;
  size: number;
  chunkIds: string[];
}

/** 等待 promise；signal 中断时立即放弃等待（索引刷新本身是共享的，在后台继续完成） */
function untilDone(p: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new RoastError('ABORTED', '检索被中断'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new RoastError('ABORTED', '检索被中断'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export function chunkLines(file: string, text: string): CodeChunk[] {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const chunks: CodeChunk[] = [];
  for (let start = 0; start < lines.length; start += CHUNK_STRIDE) {
    const end = Math.min(lines.length, start + CHUNK_LINES);
    const body = lines.slice(start, end).join('\n');
    if (body.trim()) chunks.push({ file, startLine: start + 1, endLine: end, text: body });
    if (end === lines.length) break;
  }
  return chunks;
}

function gitFiles(root: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: root, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout.split('\0').filter(Boolean)),
    );
  });
}

export async function listSourceFiles(root: string): Promise<string[]> {
  const files = (await gitFiles(root)) ?? (await walkFiles(root));
  return files
    .map((f) => f.split(path.sep).join('/'))
    .filter((f) => !SKIP_FILE.test(f) && !f.split('/').some((seg) => SKIP_DIRS.includes(seg)))
    .slice(0, MAX_FILES);
}

export class CodeIndex implements RetrievalProvider {
  private readonly index = new Bm25Index();
  private readonly chunks = new Map<string, CodeChunk>();
  private readonly files = new Map<string, FileEntry>();
  private refreshing: Promise<void> | null = null;

  warning: string | undefined;
  constructor(private readonly root: string, private readonly vectors?: VectorIndex) {}

  get stats(): { files: number; chunks: number } {
    return { files: this.files.size, chunks: this.chunks.size };
  }

  /** 增量刷新：新增 / 修改的文件重新分块，删除的文件移除；并发调用共享同一次刷新 */
  refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  /** 全异步、分批处理：大仓库建索引时也不会阻塞事件循环（TUI 保持响应） */
  private async doRefresh(): Promise<void> {
    const listed = await listSourceFiles(this.root);
    const present = new Set(listed);
    for (const file of [...this.files.keys()]) if (!present.has(file)) this.dropFile(file);
    for (let i = 0; i < listed.length; i += REFRESH_BATCH) {
      await Promise.all(listed.slice(i, i + REFRESH_BATCH).map((f) => this.syncFile(f)));
    }
  }

  private dropFile(file: string): void {
    for (const id of this.files.get(file)?.chunkIds ?? []) {
      this.index.remove(id);
      this.chunks.delete(id);
    }
    this.files.delete(file);
  }

  private async syncFile(file: string): Promise<void> {
    const abs = path.join(this.root, file);
    let st: { mtimeMs: number; size: number };
    try {
      st = await stat(abs);
    } catch {
      return this.dropFile(file);
    }
    const prev = this.files.get(file);
    if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) return;
    this.dropFile(file);
    if (st.size > MAX_FILE_BYTES) return;
    let buf: Buffer;
    try {
      buf = await readFile(abs);
    } catch {
      return;
    }
    if (buf.subarray(0, 8192).includes(0)) return;
    const pathTerms = codeTerms(file);
    const chunkIds = chunkLines(file, buf.toString('utf8')).map((c) => {
      const id = `${file}#${c.startLine}`;
      this.chunks.set(id, c);
      this.index.add(id, [...pathTerms, ...codeTerms(c.text)]);
      return id;
    });
    this.files.set(file, { mtimeMs: st.mtimeMs, size: st.size, chunkIds });
  }

  /** 检索：同一文件内重叠的块只保留得分最高的一个；pathPrefix 限定子目录 */
  async search(query: string, opts: { limit?: number; pathPrefix?: string; signal?: AbortSignal } = {}): Promise<CodeHit[]> {
    await untilDone(this.refresh(), opts.signal);
    const limit = opts.limit ?? 6;
    const prefix = opts.pathPrefix?.split(path.sep).join('/').replace(/^\.\//, '').replace(/\/$/, '');
    const inScope = (id: string) => {
      const file = this.chunks.get(id)?.file ?? '';
      return !prefix || prefix === '.' || file === prefix || file.startsWith(`${prefix}/`);
    };
    const hits: CodeHit[] = [];
    const chunks = new Map(this.chunks);
    let ranked = this.index.search(codeTerms(query), limit * 8, inScope);
    this.warning = undefined;
    if (this.vectors) {
      try {
        const semantic = await this.vectors.search(query, [...chunks].filter(([id]) => inScope(id)).map(([id, c]) => ({ id, text: `${c.file}\n${c.text}` })), opts.signal);
        const scores = new Map<string, number>();
        for (const list of [ranked, semantic.filter((x) => x.score > 0.2)]) list.forEach((h, i) => scores.set(h.id, (scores.get(h.id) ?? 0) + 1 / (60 + i + 1)));
        ranked = [...scores].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
      } catch (err) {
        if (opts.signal?.aborted) throw new RoastError('ABORTED', '检索被中断');
        this.warning = `语义检索不可用，已回退 BM25：${err instanceof Error ? err.message : '请求失败'}`;
      }
    }
    for (const { id, score } of ranked) {
      const c = chunks.get(id)!;
      if (hits.some((h) => h.file === c.file && h.startLine <= c.endLine && c.startLine <= h.endLine)) continue;
      hits.push({ ...c, score });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  async retrieve(query: string, opts: { limit?: number } = {}): Promise<RetrievedChunk[]> {
    const hits = await this.search(query, opts.limit !== undefined ? { limit: opts.limit } : {});
    return hits.map((h) => ({ source: `${h.file}:${h.startLine}-${h.endLine}`, content: h.text, score: h.score }));
  }
}
