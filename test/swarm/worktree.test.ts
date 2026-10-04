/**
 * git worktree 隔离：基线包含父工作区未提交 / 未跟踪的改动；合并成功、冲突不做部分修改；
 * 删除 worktree 时不会顺着 node_modules 链接删掉主仓库的依赖目录；子目录启动时 cwd 映射正确。
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseApplyConflicts, WorktreeManager } from '../../src/swarm/worktree.js';
import { tempWorkspace } from '../fixtures/workspace.js';

function gitRepo() {
  const ws = tempWorkspace('roast-wt-');
  const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: ws.dir, encoding: 'utf8' });
  git('init', '-q');
  ws.file('.gitignore', 'node_modules/\n');
  ws.file('src/a.ts', 'export const a = 1;\n');
  ws.file('src/b.ts', 'export const b = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return { ws, git };
}

const manager = () => new WorktreeManager({ runId: 'run1', home: tempWorkspace('roast-wt-home-').dir });

describe('WorktreeManager', () => {
  it('returns null outside git repositories', async () => {
    expect(await manager().create('w1', tempWorkspace().dir)).toBeNull();
  });

  it('snapshots uncommitted and untracked parent changes into the base, without touching the parent index', async () => {
    const { ws, git } = gitRepo();
    ws.file('src/a.ts', 'export const a = 2; // dirty\n');
    ws.file('notes.md', 'untracked\n');
    const wt = (await manager().create('w1', ws.dir))!;

    expect(readFileSync(path.join(wt.root, 'src/a.ts'), 'utf8')).toContain('dirty');
    expect(readFileSync(path.join(wt.root, 'notes.md'), 'utf8')).toBe('untracked\n');
    expect(git('status', '--porcelain').stdout).toBe(' M src/a.ts\n?? notes.md\n');
    expect(git('branch', '--list').stdout.trim()).toMatch(/^\* (master|main)$/);
  });

  it('merges child changes (edit, add, delete) into the parent working tree', async () => {
    const { ws } = gitRepo();
    const mgr = manager();
    const wt = (await mgr.create('w1', ws.dir))!;
    writeFileSync(path.join(wt.root, 'src/a.ts'), 'export const a = 42;\n');
    writeFileSync(path.join(wt.root, 'src/new.ts'), 'export const n = 1;\n');
    spawnSync('git', ['rm', '-q', 'src/b.ts'], { cwd: wt.root });

    expect((await mgr.changedFiles(wt)).sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/new.ts']);
    const r = await mgr.merge(wt);

    expect(r).toEqual({ ok: true, files: expect.arrayContaining(['src/a.ts', 'src/b.ts', 'src/new.ts']) });
    expect(readFileSync(path.join(ws.dir, 'src/a.ts'), 'utf8')).toBe('export const a = 42;\n');
    expect(existsSync(path.join(ws.dir, 'src/new.ts'))).toBe(true);
    expect(existsSync(path.join(ws.dir, 'src/b.ts'))).toBe(false);
  });

  it('reports conflicts without partially applying when the parent changed the same lines', async () => {
    const { ws } = gitRepo();
    const mgr = manager();
    const wt = (await mgr.create('w1', ws.dir))!;
    writeFileSync(path.join(wt.root, 'src/a.ts'), 'export const a = 42;\n');
    writeFileSync(path.join(wt.root, 'src/b.ts'), 'export const b = 42;\n');
    ws.file('src/a.ts', 'export const a = 7; // parent edit\n');

    const r = await mgr.merge(wt);

    expect(r.ok).toBe(false);
    expect(r.ok ? [] : r.conflicts).toEqual(['src/a.ts']);
    expect(readFileSync(path.join(ws.dir, 'src/b.ts'), 'utf8')).toBe('export const b = 1;\n');
  });

  it('copies node_modules privately and removing the worktree keeps the original', async () => {
    const { ws } = gitRepo();
    ws.file('node_modules/pkg/index.js', 'module.exports = 1;\n');
    const mgr = manager();
    const wt = (await mgr.create('w1', ws.dir))!;
    expect(readFileSync(path.join(wt.root, 'node_modules/pkg/index.js'), 'utf8')).toBe('module.exports = 1;\n');
    expect(lstatSync(path.join(wt.root, 'node_modules')).isSymbolicLink()).toBe(false);
    writeFileSync(path.join(wt.root, 'node_modules/pkg/index.js'), 'installed a new version');
    expect(readFileSync(path.join(ws.dir, 'node_modules/pkg/index.js'), 'utf8')).toBe('module.exports = 1;\n');
    expect(await mgr.changedFiles(wt)).toEqual([]);

    await mgr.remove(wt);

    expect(existsSync(wt.root)).toBe(false);
    expect(existsSync(path.join(ws.dir, 'node_modules/pkg/index.js'))).toBe(true);
  });

  it('remaps dependency junctions and copies external linked packages without backlinks', async () => {
    const { ws } = gitRepo();
    const external = tempWorkspace();
    external.file('index.js', 'external');
    ws.file('node_modules/.pnpm/pkg/index.js', 'internal');
    symlinkSync(path.join(ws.dir, 'node_modules/.pnpm/pkg'), path.join(ws.dir, 'node_modules/pkg'), process.platform === 'win32' ? 'junction' : 'dir');
    symlinkSync(external.dir, path.join(ws.dir, 'node_modules/external'), process.platform === 'win32' ? 'junction' : 'dir');
    const mgr = manager(); const wt = (await mgr.create('w1', ws.dir))!;
    try {
      writeFileSync(path.join(wt.root, 'node_modules/pkg/index.js'), 'changed internal');
      writeFileSync(path.join(wt.root, 'node_modules/external/index.js'), 'changed external');
      expect(readFileSync(path.join(ws.dir, 'node_modules/pkg/index.js'), 'utf8')).toBe('internal');
      expect(readFileSync(path.join(external.dir, 'index.js'), 'utf8')).toBe('external');
    } finally { await mgr.remove(wt); }
  });

  it('never snapshots RoastCli state (.roast) even when the project does not ignore it', async () => {
    const { ws } = gitRepo();
    ws.file('.roast/shadow.git/HEAD', 'ref: refs/heads/master\n');
    ws.file('.roast/logs/run.jsonl', '{}\n');
    const wt = (await manager().create('w1', ws.dir))!;
    expect(existsSync(path.join(wt.root, '.roast'))).toBe(false);
    expect(existsSync(path.join(wt.root, 'src/a.ts'))).toBe(true);
  });

  it('maps a subdirectory cwd into the worktree', async () => {
    const { ws } = gitRepo();
    const wt = (await manager().create('w1', path.join(ws.dir, 'src')))!;
    expect(wt.cwd).toBe(path.join(wt.root, 'src'));
    expect(existsSync(path.join(wt.cwd, 'a.ts'))).toBe(true);
  });
});

describe('WorktreeManager regressions (M8 review)', () => {
  it('merges cleanly in a CRLF-on-disk clone (core.autocrlf=true), keeping each file\'s line endings', async () => {
    const { ws, git } = gitRepo();
    ws.file('crlf.txt', 'one\ntwo\n');
    git('-c', 'core.autocrlf=false', 'add', '-A');
    git('commit', '-q', '-m', 'crlf');
    // 模拟 autocrlf=true 下的检出：git 自己写出 CRLF 文件并刷新索引（干净文件，索引里是 LF blob）
    rmSync(path.join(ws.dir, 'crlf.txt'));
    git('-c', 'core.autocrlf=true', 'checkout', '--', 'crlf.txt');
    expect(readFileSync(path.join(ws.dir, 'crlf.txt'), 'utf8')).toBe('one\r\ntwo\r\n');
    // 等过 git 的 racy-clean 窗口再刷新索引：此后干净文件只凭 stat 判断（真实场景），旧实现会沿用 LF blob 而误报冲突
    await new Promise((r) => setTimeout(r, 1500));
    git('-c', 'core.autocrlf=true', 'update-index', '--refresh');
    const mgr = manager();
    const wt = (await mgr.create('w1', ws.dir))!;
    expect(readFileSync(path.join(wt.root, 'crlf.txt'), 'utf8')).toBe('one\r\ntwo\r\n');
    writeFileSync(path.join(wt.root, 'crlf.txt'), 'one\r\nTWO\r\n');
    writeFileSync(path.join(wt.root, 'src/a.ts'), 'export const a = 3;\n');

    expect(await mgr.merge(wt)).toMatchObject({ ok: true });
    expect(readFileSync(path.join(ws.dir, 'crlf.txt'), 'utf8')).toBe('one\r\nTWO\r\n');
    expect(readFileSync(path.join(ws.dir, 'src/a.ts'), 'utf8')).toBe('export const a = 3;\n');
  });

  it('ignores the user\'s diff.noprefix setting when building the merge patch', async () => {
    const { ws, git } = gitRepo();
    git('config', 'diff.noprefix', 'true');
    const mgr = manager();
    const wt = (await mgr.create('w1', ws.dir))!;
    ws.file('../placeholder', '');
    writeFileSync(path.join(wt.root, 'src/deep.ts'), 'x\n');
    expect(await mgr.merge(wt)).toMatchObject({ ok: true });
    expect(existsSync(path.join(ws.dir, 'src/deep.ts'))).toBe(true);
    expect(existsSync(path.join(ws.dir, 'deep.ts'))).toBe(false);
  });

  it('preserves non-UTF-8 bytes through the merge', async () => {
    const { ws } = gitRepo();
    const mgr = manager();
    const wt = (await mgr.create('w1', ws.dir))!;
    const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0a]);
    writeFileSync(path.join(wt.root, 'gbk.txt'), gbk);
    expect(await mgr.merge(wt)).toMatchObject({ ok: true });
    expect(readFileSync(path.join(ws.dir, 'gbk.txt')).equals(gbk)).toBe(true);
  });

  it('does not run the user\'s post-checkout hook when creating a worktree', async () => {
    const { ws } = gitRepo();
    ws.file('.git/hooks/post-checkout', '#!/bin/sh\nexit 1\n');
    const wt = await manager().create('w1', ws.dir);
    expect(wt && existsSync(wt.root)).toBe(true);
  });
});

describe('parseApplyConflicts', () => {
  it('extracts file names from git apply errors', () => {
    const stderr = ['error: patch failed: src/a.ts:1', 'error: src/a.ts: patch does not apply', 'error: src/c.ts: already exists in working directory'].join('\n');
    expect(parseApplyConflicts(stderr)).toEqual(['src/a.ts', 'src/c.ts']);
  });
});
