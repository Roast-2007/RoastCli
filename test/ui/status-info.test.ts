import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { costOf, formatCost, gitBranch } from '../../src/ui/status-info.js';
import { tempWorkspace } from '../fixtures/workspace.js';

describe('gitBranch', () => {
  it('reads the branch from HEAD, from subdirectories and linked worktrees; null outside git', () => {
    const ws = tempWorkspace('roast-branch-');
    const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: ws.dir, encoding: 'utf8' });
    git('init', '-q', '-b', 'feature/x');
    ws.file('src/a.ts', 'x');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    expect(gitBranch(ws.dir)).toBe('feature/x');
    expect(gitBranch(path.join(ws.dir, 'src'))).toBe('feature/x');

    const wt = path.join(tempWorkspace('roast-branch-wt-').dir, 'w');
    git('worktree', 'add', '-q', '--detach', wt);
    expect(gitBranch(wt)).toMatch(/^[0-9a-f]{7}$/);
    expect(gitBranch(tempWorkspace().dir)).toBeNull();
  });
});

describe('costOf', () => {
  it('prices input, output and cache tokens per million, defaulting cache prices to input', () => {
    const usage = { input: 1_000_000, output: 500_000, cacheRead: 2_000_000, cacheWrite: 0 };
    expect(costOf(usage, { input: 1, output: 4 })).toBe(5);
    expect(costOf(usage, { input: 1, output: 4, cacheRead: 0.1 })).toBeCloseTo(3.2);
    expect(formatCost(0.004)).toBe('$0.0040');
    expect(formatCost(1.234)).toBe('$1.23');
  });
});
