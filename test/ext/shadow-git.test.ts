import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ShadowGit } from '../../src/ext/audit/shadow-git.js';
import { tempWorkspace } from '../fixtures/workspace.js';

describe('ShadowGit', () => {
  it('快照后修改/新增/删除文件，restore 恢复到快照状态；不影响 .roast 与 node_modules', async () => {
    const ws = tempWorkspace('roast-shadow-');
    ws.file('a.txt', 'v1\n');
    ws.file('c.txt', 'keep me\n');
    ws.file('node_modules/x.js', 'dep\n');
    const shadow = new ShadowGit(ws.dir);
    const h1 = await shadow.snapshot('turn 1');
    expect(h1).toMatch(/^[0-9a-f]{40}$/);

    writeFileSync(path.join(ws.dir, 'a.txt'), 'v2\n');
    ws.file('src/new.ts', 'new\n');
    rmSync(path.join(ws.dir, 'c.txt'));
    writeFileSync(path.join(ws.dir, 'node_modules/x.js'), 'dep changed\n');

    const r = await shadow.restore(h1!);
    expect(readFileSync(path.join(ws.dir, 'a.txt'), 'utf8')).toBe('v1\n');
    expect(existsSync(path.join(ws.dir, 'src/new.ts'))).toBe(false);
    expect(readFileSync(path.join(ws.dir, 'c.txt'), 'utf8')).toBe('keep me\n');
    expect(readFileSync(path.join(ws.dir, 'node_modules/x.js'), 'utf8')).toBe('dep changed\n');
    expect(r.deleted).toEqual(['src/new.ts']);

    // 撤销 rewind：恢复到 backup
    await shadow.restore(r.backup);
    expect(readFileSync(path.join(ws.dir, 'a.txt'), 'utf8')).toBe('v2\n');
    expect(existsSync(path.join(ws.dir, 'src/new.ts'))).toBe(true);
  }, 30_000);

  it('空目录也能快照与恢复', async () => {
    const ws = tempWorkspace('roast-shadow-empty-');
    const shadow = new ShadowGit(ws.dir);
    const h = await shadow.snapshot('empty');
    ws.file('later.txt', 'x');
    await shadow.restore(h!);
    expect(existsSync(path.join(ws.dir, 'later.txt'))).toBe(false);
  }, 30_000);
});
