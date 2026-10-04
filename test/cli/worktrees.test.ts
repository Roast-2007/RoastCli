import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorktreeManager } from '../../src/swarm/worktree.js';
import { listWorktrees, pruneWorktrees, savedWorktreesText } from '../../src/cli/worktrees.js';
import { tempWorkspace } from '../fixtures/workspace.js';

function repo() {
  const ws = tempWorkspace();
  const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: ws.dir, encoding: 'utf8' });
  git('init', '-q'); ws.file('a', 'base\n'); git('add', '.'); git('commit', '-qm', 'init');
  return ws;
}

describe('worktree maintenance', () => {
  it('lists only registered Roast worktrees in this repository; pruning keeps changes and other projects', async () => {
    const ws = repo(); const other = repo(); const home = tempWorkspace().dir;
    const mgr = new WorktreeManager({ runId: 'old-run', home });
    const clean = (await mgr.create('w1', ws.dir))!;
    const dirty = (await mgr.create('w2', ws.dir))!;
    const foreign = (await mgr.create('w3', other.dir))!;
    writeFileSync(path.join(dirty.root, 'a'), 'unmerged\n');
    await mgr.release(clean); await mgr.release(dirty); await mgr.release(foreign);
    expect((await listWorktrees(ws.dir, home)).map((w) => w.agentId)).toEqual(['w1', 'w2']);
    const result = await pruneWorktrees(ws.dir, home);
    expect(result.removed).toEqual([clean.root]);
    expect(result.kept).toEqual([dirty.root]);
    expect(existsSync(clean.root)).toBe(false);
    expect(readFileSync(path.join(dirty.root, 'a'), 'utf8')).toBe('unmerged\n');
    expect(existsSync(foreign.root)).toBe(true);
    expect(savedWorktreesText(result.kept)).toContain(dirty.root);
    await mgr.remove(dirty); await mgr.remove(foreign);
  }, 30_000);

  it('never prunes worktrees owned by a live session, or unregistered directories', async () => {
    const ws = repo(); const home = tempWorkspace();
    const mgr = new WorktreeManager({ runId: 'active-run', home: home.dir });
    const active = (await mgr.create('w1', ws.dir))!;
    const arbitrary = home.file('worktrees/old/w9/valuable.txt', 'keep');
    const result = await pruneWorktrees(ws.dir, home.dir);
    expect(result.active).toEqual([active.root]);
    expect(existsSync(active.root)).toBe(true);
    expect(readFileSync(arbitrary, 'utf8')).toBe('keep');
    await mgr.remove(active);
  }, 30_000);

  it('uses the saved baseline even after a worker commits its changes', async () => {
    const ws = repo(); const home = tempWorkspace().dir;
    const mgr = new WorktreeManager({ runId: 'old-run', home });
    const wt = (await mgr.create('w1', ws.dir))!;
    writeFileSync(path.join(wt.root, 'new'), 'committed feature');
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'add', '.'], { cwd: wt.root });
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'feature'], { cwd: wt.root });
    await mgr.release(wt);
    expect((await pruneWorktrees(ws.dir, home)).kept).toEqual([wt.root]);
    await mgr.remove(wt);
  }, 30_000);
});
