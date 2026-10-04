import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { executeTool } from '../../src/tools/executor.js';
import { multiEditTool } from '../../src/tools/multi-edit/index.js';
import { readTool } from '../../src/tools/read/index.js';
import { writeTool } from '../../src/tools/write/index.js';
import { makeDiff } from '../../src/tools/file-ops.js';
import { makeCtx, makeTmpDir, textOf } from './helpers.js';

describe('write 工具', () => {
  it('创建新文件（含父目录）并返回 diff', async () => {
    const dir = await makeTmpDir();
    const ctx = makeCtx(dir);
    const r = await executeTool(writeTool, { path: 'src/new/a.ts', content: 'export const a = 1;\n' }, ctx);
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(await readFile(path.join(dir, 'src/new/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(r.metadata).toMatchObject({ created: true, diff: { added: 1, removed: 0 } });
  });

  it('覆盖已有文件前必须先 read', async () => {
    const dir = await makeTmpDir();
    await writeFile(path.join(dir, 'a.txt'), 'old', 'utf8');
    const ctx = makeCtx(dir);
    const r = await executeTool(writeTool, { path: 'a.txt', content: 'new' }, ctx);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('尚未被读取');
    expect(await readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('old');
  });

  it('覆盖时保持原 CRLF 换行风格', async () => {
    const dir = await makeTmpDir();
    await writeFile(path.join(dir, 'w.txt'), 'a\r\nb\r\n', 'utf8');
    const ctx = makeCtx(dir);
    await executeTool(readTool, { path: 'w.txt' }, ctx);
    const r = await executeTool(writeTool, { path: 'w.txt', content: 'x\ny\nz\n' }, ctx);
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(await readFile(path.join(dir, 'w.txt'), 'utf8')).toBe('x\r\ny\r\nz\r\n');
  });
});

describe('multi_edit 工具', () => {
  it('按顺序应用多处替换', async () => {
    const dir = await makeTmpDir();
    await writeFile(path.join(dir, 'm.ts'), 'let a = 1;\nlet b = 2;\n', 'utf8');
    const ctx = makeCtx(dir);
    await executeTool(readTool, { path: 'm.ts' }, ctx);
    const r = await executeTool(
      multiEditTool,
      { path: 'm.ts', edits: [{ old_string: 'let a', new_string: 'const a' }, { old_string: 'const a = 1', new_string: 'const a = 10' }] },
      ctx,
    );
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(await readFile(path.join(dir, 'm.ts'), 'utf8')).toBe('const a = 10;\nlet b = 2;\n');
  });

  it('任一处失败则整体不写入', async () => {
    const dir = await makeTmpDir();
    await writeFile(path.join(dir, 'm.ts'), 'x = 1\n', 'utf8');
    const ctx = makeCtx(dir);
    await executeTool(readTool, { path: 'm.ts' }, ctx);
    const r = await executeTool(
      multiEditTool,
      { path: 'm.ts', edits: [{ old_string: 'x', new_string: 'y' }, { old_string: 'nope', new_string: 'z' }] },
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('第 2 处');
    expect(await readFile(path.join(dir, 'm.ts'), 'utf8')).toBe('x = 1\n');
  });
});

describe('makeDiff', () => {
  it('统计增删行并给出 hunk', () => {
    const d = makeDiff('a.ts', 'a\nb\nc\n', 'a\nB\nc\nd\n');
    expect(d.added).toBe(2);
    expect(d.removed).toBe(1);
    expect(d.hunks[0]!.lines).toContain('-b');
    expect(d.hunks[0]!.lines).toContain('+B');
  });

  it('超长 diff 截断并标注', () => {
    const before = Array.from({ length: 1000 }, (_, i) => `l${i}`).join('\n');
    const after = Array.from({ length: 1000 }, (_, i) => `L${i}`).join('\n');
    const d = makeDiff('big', before, after);
    expect(d.truncated).toBe(true);
    expect(d.added).toBe(1000);
    expect(d.hunks.reduce((n, h) => n + h.lines.length, 0)).toBeLessThanOrEqual(400);
  });
});
