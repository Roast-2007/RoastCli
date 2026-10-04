import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalPath, resolveUserPath } from '../../src/core/paths.js';

const isWin = process.platform === 'win32';

describe('canonicalPath', () => {
  it('同一文件的不同写法（tmpdir 短路径 vs realpath）得到同一身份键', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'roast-paths-'));
    const file = path.join(dir, 'a.txt');
    writeFileSync(file, 'x');
    const real = path.join(realpathSync.native(dir), 'a.txt');
    expect(canonicalPath(file)).toBe(canonicalPath(real));
  });

  it.runIf(isWin)('Windows 下大小写不敏感', () => {
    const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'roast-paths-')));
    const file = path.join(dir, 'Case.txt');
    writeFileSync(file, 'x');
    expect(canonicalPath(file)).toBe(canonicalPath(file.toUpperCase()));
  });

  it('不存在的文件：规范化其所在目录', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'roast-paths-'));
    const missing = path.join(dir, 'nope.txt');
    const expected = path.join(realpathSync.native(dir), 'nope.txt');
    expect(canonicalPath(missing)).toBe(isWin ? expected.toLowerCase() : expected);
  });
});

describe('resolveUserPath', () => {
  it('相对路径基于 cwd 解析', () => {
    const cwd = path.resolve('/tmp/proj');
    expect(resolveUserPath(cwd, 'src/a.ts')).toBe(path.join(cwd, 'src', 'a.ts'));
  });

  it.runIf(isWin)('git-bash 风格 /d/x 转为 D:\\x', () => {
    expect(resolveUserPath('C:\\work', '/d/Personal Files/a.ts')).toBe('D:\\Personal Files\\a.ts');
    expect(resolveUserPath('C:\\work', '/c')).toBe('C:\\');
  });

  it.runIf(isWin)('git-bash 的 /tmp 映射到系统临时目录', () => {
    expect(resolveUserPath('C:\\work', '/tmp/x/y.txt')).toBe(path.join(tmpdir(), 'x', 'y.txt'));
    expect(resolveUserPath('C:\\work', '/tmp')).toBe(path.resolve(tmpdir()));
  });

  it.runIf(isWin)('普通绝对路径保持不变', () => {
    expect(resolveUserPath('C:\\work', 'D:\\x\\y.ts')).toBe('D:\\x\\y.ts');
  });
});

describe('canonicalPath for missing paths', () => {
  it('resolves the nearest existing ancestor so nested missing paths stay comparable', async () => {
    const { canonicalPath, isPathInside } = await import('../../src/core/paths.js');
    const { mkdtempSync, mkdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const pathMod = (await import('node:path')).default;
    const base = mkdtempSync(pathMod.join(tmpdir(), 'cp-'));
    mkdirSync(pathMod.join(base, 'exists'));
    const root = pathMod.join(base, 'exists', 'missing-run');
    const deep = pathMod.join(root, 'w1', 'a.ts');
    expect(canonicalPath(deep).startsWith(canonicalPath(root))).toBe(true);
    expect(isPathInside(root, deep)).toBe(true);
  });
});
