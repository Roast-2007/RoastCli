import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { executeTool } from '../../src/tools/executor.js';
import { readTool } from '../../src/tools/read/index.js';
import { makeCtx, makeTmpDir, textOf } from './helpers.js';

describe('read 工具', () => {
  it('读临时文件：行号前缀与内容', async () => {
    const dir = await makeTmpDir();
    await writeFile(path.join(dir, 'a.txt'), 'first\nsecond\nthird\n', 'utf8');
    const result = await executeTool(readTool, { path: 'a.txt' }, makeCtx(dir));
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain('1\tfirst');
    expect(text).toContain('2\tsecond');
    expect(text).toContain('3\tthird');
  });

  it('offset / limit 分页', async () => {
    const dir = await makeTmpDir();
    const body = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n');
    await writeFile(path.join(dir, 'b.txt'), body, 'utf8');
    const result = await executeTool(readTool, { path: 'b.txt', offset: 4, limit: 2 }, makeCtx(dir));
    const text = textOf(result);
    expect(text).toContain('4\tline4');
    expect(text).toContain('5\tline5');
    expect(text).not.toContain('3\tline3');
    expect(text).not.toContain('6\tline6');
  });

  it('超过 limit 时给出截断提示（含总行数）', async () => {
    const dir = await makeTmpDir();
    const body = Array.from({ length: 5 }, (_, i) => `l${i + 1}`).join('\n');
    await writeFile(path.join(dir, 'c.txt'), body, 'utf8');
    const result = await executeTool(readTool, { path: 'c.txt', limit: 2 }, makeCtx(dir));
    const text = textOf(result);
    expect(text).toContain('共 5 行');
    expect(text).toContain('截断');
  });

  it('二进制文件拒绝读取', async () => {
    const dir = await makeTmpDir();
    const buf = Buffer.concat([Buffer.from('abc'), Buffer.from([0x00]), Buffer.alloc(16, 1)]);
    await writeFile(path.join(dir, 'bin.dat'), buf);
    const result = await executeTool(readTool, { path: 'bin.dat' }, makeCtx(dir));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('二进制');
  });

  it('文件不存在 / 是目录：模型可读 isError', async () => {
    const dir = await makeTmpDir();
    const missing = await executeTool(readTool, { path: 'nope.txt' }, makeCtx(dir));
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain('不存在');
    const asDir = await executeTool(readTool, { path: '.' }, makeCtx(dir));
    expect(asDir.isError).toBe(true);
    expect(textOf(asDir)).toContain('目录');
  });
});
