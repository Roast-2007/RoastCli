import { readFile, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { editTool } from '../../src/tools/edit/index.js';
import { executeTool } from '../../src/tools/executor.js';
import { readTool } from '../../src/tools/read/index.js';
import type { ToolContext } from '../../src/tools/tool.js';
import { makeCtx, makeTmpDir, textOf } from './helpers.js';

async function readThen(ctx: ToolContext, dir: string, file: string): Promise<void> {
  const r = await executeTool(readTool, { path: file }, ctx);
  if (r.isError) throw new Error(`read failed: ${textOf(r)}`);
}

describe('edit 工具', () => {
  it('未读先改被拒', async () => {
    const dir = await makeTmpDir();
    await writeFile(path.join(dir, 'a.txt'), 'hello world', 'utf8');
    const result = await executeTool(
      editTool,
      { path: 'a.txt', old_string: 'world', new_string: 'roast' },
      makeCtx(dir),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('先用 read 工具读取');
  });

  it('读后可改，metadata 携带替换统计', async () => {
    const dir = await makeTmpDir();
    await writeFile(path.join(dir, 'a.txt'), 'hello world', 'utf8');
    const ctx = makeCtx(dir);
    await readThen(ctx, dir, 'a.txt');
    const result = await executeTool(
      editTool,
      { path: 'a.txt', old_string: 'world', new_string: 'roast' },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.metadata).toMatchObject({ replacements: 1, bytesBefore: 11, bytesAfter: 11 });
    expect(await readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('hello roast');
  });

  it('old_string 多次出现（replace_all=false）→ isError 并列出行号', async () => {
    const dir = await makeTmpDir();
    await writeFile(path.join(dir, 'a.txt'), 'foo\nbar\nfoo\n', 'utf8');
    const ctx = makeCtx(dir);
    await readThen(ctx, dir, 'a.txt');
    const result = await executeTool(
      editTool,
      { path: 'a.txt', old_string: 'foo', new_string: 'baz' },
      ctx,
    );
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('2 次');
    expect(text).toContain('行号: 1, 3');
  });

  it('replace_all=true 替换所有出现', async () => {
    const dir = await makeTmpDir();
    await writeFile(path.join(dir, 'a.txt'), 'foo\nbar\nfoo\n', 'utf8');
    const ctx = makeCtx(dir);
    await readThen(ctx, dir, 'a.txt');
    const result = await executeTool(
      editTool,
      { path: 'a.txt', old_string: 'foo', new_string: 'baz', replace_all: true },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.metadata).toMatchObject({ replacements: 2 });
    expect(await readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('baz\nbar\nbaz\n');
  });

  it('外部修改后拒绝编辑', async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, 'a.txt');
    await writeFile(file, 'hello world', 'utf8');
    const ctx = makeCtx(dir);
    await readThen(ctx, dir, 'a.txt');
    // 模拟外部修改（内容变化）
    await writeFile(file, 'hello WORLD', 'utf8');
    const result = await executeTool(
      editTool,
      { path: 'a.txt', old_string: 'hello', new_string: 'hi' },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('外部修改');
  });

  it('mtime/size 变了但内容哈希一致 → 放行', async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, 'a.txt');
    await writeFile(file, 'hello world', 'utf8');
    const ctx = makeCtx(dir);
    await readThen(ctx, dir, 'a.txt');
    // touch：改 mtime，不改内容
    const future = new Date(Date.now() + 60_000);
    await utimes(file, future, future);
    const result = await executeTool(
      editTool,
      { path: 'a.txt', old_string: 'world', new_string: 'roast' },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(await readFile(file, 'utf8')).toBe('hello roast');
  });

  it('CRLF 文件写回保持 CRLF', async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, 'crlf.txt');
    await writeFile(file, 'a\r\nb\r\n', 'utf8');
    const ctx = makeCtx(dir);
    await readThen(ctx, dir, 'crlf.txt');
    const result = await executeTool(
      editTool,
      { path: 'crlf.txt', old_string: 'a\nb', new_string: 'x\ny' },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(await readFile(file, 'utf8')).toBe('x\r\ny\r\n');
  });

  it('edit 后再次 edit 无需重新 read（read-state 已更新）', async () => {
    const dir = await makeTmpDir();
    await writeFile(path.join(dir, 'a.txt'), 'one two three', 'utf8');
    const ctx = makeCtx(dir);
    await readThen(ctx, dir, 'a.txt');
    const r1 = await executeTool(editTool, { path: 'a.txt', old_string: 'one', new_string: '1' }, ctx);
    expect(r1.isError).toBeFalsy();
    const r2 = await executeTool(editTool, { path: 'a.txt', old_string: 'two', new_string: '2' }, ctx);
    expect(r2.isError).toBeFalsy();
    expect(await readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('1 2 three');
  });
});

describe('edit 工具：路径身份', () => {
  it('read 用短路径/相对路径、edit 用 realpath 绝对路径，仍视为同一文件', async () => {
    const { realpathSync } = await import('node:fs');
    const dir = await makeTmpDir(); // Windows 上可能是 8.3 短路径
    await writeFile(path.join(dir, 'p.txt'), 'alpha beta', 'utf8');
    const ctx = makeCtx(dir);
    await readThen(ctx, dir, 'p.txt');
    const realAbs = path.join(realpathSync.native(dir), 'p.txt');
    const target = process.platform === 'win32' ? realAbs.toUpperCase() : realAbs;
    const result = await executeTool(editTool, { path: target, old_string: 'beta', new_string: 'gamma' }, ctx);
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(await readFile(path.join(dir, 'p.txt'), 'utf8')).toBe('alpha gamma');
  });
});

describe('edit 工具：替换串中的 $ 字面量', () => {
  it('new_string 里的 $$ / $& 原样写入', async () => {
    const dir = await makeTmpDir();
    await writeFile(path.join(dir, 'Makefile'), 'X = old\n', 'utf8');
    const ctx = makeCtx(dir);
    await readThen(ctx, dir, 'Makefile');
    const result = await executeTool(editTool, { path: 'Makefile', old_string: 'old', new_string: '$$HOME $& $1' }, ctx);
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(await readFile(path.join(dir, 'Makefile'), 'utf8')).toBe('X = $$HOME $& $1\n');
  });
});
