import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorktreeManager } from '../../src/swarm/worktree.js';
import { readDiff } from '../../src/swarm/diff.js';
import { tempWorkspace } from '../fixtures/workspace.js';
describe('read-only diff review', () => {
  it('reviews committed, unstaged and untracked writer changes against the real baseline without changing either index', async () => {
    const ws = tempWorkspace(), git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: ws.dir, encoding: 'utf8' }).stdout.trim();
    git('init', '-q'); ws.file('a.txt', 'base\n'); git('add', 'a.txt'); git('commit', '-qm', 'baseline');
    ws.file('a.txt', 'parent draft\n');
    const manager = new WorktreeManager({ runId: 'review', home: tempWorkspace().dir }), wt = (await manager.create('w1', ws.dir))!;
    try {
      writeFileSync(path.join(wt.root, 'a.txt'), 'committed child\n');
      spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-qam', 'child'], { cwd: wt.root });
      writeFileSync(path.join(wt.root, 'new.txt'), 'new child\n');
      git('config', 'diff.external', 'nonexistent-review-external-command');
      const index = readFileSync(path.join(ws.dir, '.git/index'));
      const result = await readDiff({ cwd: wt.cwd, base: wt.base });
      expect(result).toMatchObject({ files: 2, added: 2, removed: 1 });
      expect(result.diff).toContain('-parent draft'); expect(result.diff).toContain('+committed child'); expect(result.diff).toContain('+new child');
      expect(readFileSync(path.join(ws.dir, '.git/index'))).toEqual(index); expect(readFileSync(path.join(ws.dir, 'a.txt'), 'utf8')).toBe('parent draft\n');
      const abort = new AbortController(); abort.abort(); await expect(readDiff({ cwd: wt.cwd, base: wt.base }, abort.signal)).rejects.toBeDefined();
      await expect(readDiff({ cwd: wt.cwd, base: '--output=bad' })).rejects.toThrow('基线');
    } finally { await manager.remove(wt); }
  });
});
