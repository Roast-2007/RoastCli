/**
 * 写类工具（edit / multi_edit / write）的共享核心：
 * - loadForWrite：先读后改校验（同一会话内必须 read 过且未被外部修改，以内容 sha1 为准）
 * - applyEdit：纯函数字符串替换（唯一性校验、replace_all、$ 字面量安全）
 * - commitWrite：按原换行风格写回、刷新读状态、生成结构化 diff（UI 渲染 / 审计）
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { structuredPatch } from 'diff';
import { getFileStateStore, sha1Of, type FileState } from './fs-state.js';
import type { ToolServices } from './tool.js';

export interface LoadedFile {
  abs: string;
  /** LF 归一后的内容（模型给出的片段通常是 LF） */
  content: string;
  crlf: boolean;
  bytes: number;
}

export type LoadResult = { ok: true; file: LoadedFile } | { ok: false; error: string };

export async function loadForWrite(abs: string, services: ToolServices): Promise<LoadResult> {
  const store = getFileStateStore(services);
  const prev = store.get(abs);
  if (!prev) return { ok: false, error: `文件 ${abs} 尚未被读取。请先用 read 工具读取该文件后再修改。` };
  let st;
  try {
    st = await stat(abs);
  } catch {
    return { ok: false, error: `文件不存在: ${abs}` };
  }
  const buf = await readFile(abs);
  const sha1 = sha1Of(buf);
  if (sha1 !== prev.sha1) {
    return { ok: false, error: `文件 ${abs} 自上次读取后已被外部修改。请重新用 read 工具读取最新内容后再修改。` };
  }
  // mtime/size 变了但内容一致（touch、原样重写）→ 刷新记录后放行
  if (st.mtimeMs !== prev.mtimeMs || st.size !== prev.size) store.record(abs, { mtimeMs: st.mtimeMs, size: st.size, sha1 });
  const raw = buf.toString('utf8');
  const crlf = raw.includes('\r\n');
  return { ok: true, file: { abs, content: crlf ? raw.replace(/\r\n/g, '\n') : raw, crlf, bytes: buf.length } };
}

export interface EditSpec {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export type EditResult = { ok: true; content: string; count: number } | { ok: false; error: string };

function indicesOf(haystack: string, needle: string): number[] {
  const out: number[] = [];
  for (let from = 0; ; ) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) return out;
    out.push(i);
    from = i + needle.length;
  }
}

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}

export function applyEdit(content: string, edit: EditSpec): EditResult {
  if (edit.old_string === '') return { ok: false, error: 'old_string 不能为空字符串。' };
  if (edit.old_string === edit.new_string) return { ok: false, error: 'old_string 与 new_string 相同，没有任何改动。' };
  const hits = indicesOf(content, edit.old_string);
  if (hits.length === 0) {
    return { ok: false, error: 'old_string 在文件中未找到。请确认内容与缩进完全匹配（可先用 read 查看最新内容）。' };
  }
  if (!edit.replace_all && hits.length > 1) {
    const lines = hits.map((i) => lineOf(content, i)).join(', ');
    return {
      ok: false,
      error: `old_string 在文件中出现 ${hits.length} 次（行号: ${lines}），但 replace_all=false。请提供更长的唯一上下文，或设置 replace_all=true。`,
    };
  }
  const next = edit.replace_all
    ? content.split(edit.old_string).join(edit.new_string)
    : content.replace(edit.old_string, () => edit.new_string); // 函数替换：$ 系列模式按字面量处理
  return { ok: true, content: next, count: edit.replace_all ? hits.length : 1 };
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface DiffMeta {
  hunks: DiffHunk[];
  added: number;
  removed: number;
  truncated?: boolean;
}

const MAX_DIFF_LINES = 400;

export function makeDiff(file: string, before: string, after: string): DiffMeta {
  const patch = structuredPatch(file, file, before, after, '', '', { context: 3 });
  let added = 0;
  let removed = 0;
  let budget = MAX_DIFF_LINES;
  let truncated = false;
  const hunks: DiffHunk[] = [];
  for (const h of patch.hunks) {
    for (const l of h.lines) {
      if (l.startsWith('+')) added++;
      else if (l.startsWith('-')) removed++;
    }
    if (budget <= 0) {
      truncated = true;
      continue;
    }
    const lines = h.lines.slice(0, budget);
    if (lines.length < h.lines.length) truncated = true;
    budget -= lines.length;
    hunks.push({ oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, lines });
  }
  return { hunks, added, removed, ...(truncated ? { truncated: true } : {}) };
}

export interface WriteOutcome {
  fileState: FileState;
  diff: DiffMeta;
  bytes: number;
}

/** 写回（content 为 LF 归一文本，crlf 时还原），刷新读状态，返回 diff */
export async function commitWrite(
  abs: string,
  before: string,
  after: string,
  crlf: boolean,
  services: ToolServices,
): Promise<WriteOutcome> {
  const outText = crlf ? after.replace(/\n/g, '\r\n') : after;
  const outBuf = Buffer.from(outText, 'utf8');
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, outBuf);
  const st = await stat(abs);
  const fileState: FileState = { mtimeMs: st.mtimeMs, size: st.size, sha1: sha1Of(outBuf) };
  getFileStateStore(services).record(abs, fileState);
  return { fileState, diff: makeDiff(path.basename(abs), before, after), bytes: outBuf.length };
}
