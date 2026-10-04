import { describe, expect, it } from 'vitest';
import { formatMerge, wantsWorktree, worktreeGuardHook } from '../../src/swarm/isolation.js';
import { readTool, writeTool } from '../../src/tools/index.js';
import { makeCtx } from '../tools/helpers.js';
import path from 'node:path';
import { memoryTool } from '../../src/ext/memory/local.js';

const wt = { agentId: 'w1', root: path.resolve('/home/u/.roast/worktrees/r/run/w1'), cwd: path.resolve('/home/u/.roast/worktrees/r/run/w1'), base: 'abcdef1234567890', parentRoot: path.resolve('/repo') };

describe('isolation helpers', () => {
  it('chooses worktrees for writer roles under auto, always under worktree, never under shared', () => {
    expect(wantsWorktree('auto', 'worker')).toBe(true);
    expect(wantsWorktree('auto', 'scout')).toBe(false);
    expect(wantsWorktree('worktree', 'critic')).toBe(true);
    expect(wantsWorktree('shared', 'lead')).toBe(false);
  });

  it('formats merge results, with a resolver recipe on conflicts', () => {
    expect(formatMerge('w1', { ok: true, files: [] })).toContain('没有任何文件改动');
    expect(formatMerge('w1', { ok: true, files: ['a.ts'] })).toContain('（1 个文件）');
    const text = formatMerge('w1', { ok: false, conflicts: ['a.ts'], detail: '' }, wt);
    expect(text).toContain('- a.ts');
    expect(text).toContain('abcdef123456');
    expect(text).toContain('合并者');
    expect(text).toContain('discard: true');
  });

  it('guards edits into the original repo but allows reads and worktree edits', async () => {
    const guard = worktreeGuardHook(wt);
    const ctx = makeCtx(wt.cwd);
    const denied = await guard(writeTool, { path: path.join(wt.parentRoot, 'src', 'a.ts'), content: 'x' }, ctx);
    expect(denied).toMatchObject({ action: 'deny', reason: expect.stringContaining(path.join(wt.root, 'src', 'a.ts')) });
    expect(await guard(writeTool, { path: 'src/a.ts', content: 'x' }, ctx)).toEqual({ action: 'allow' });
    expect(await guard(readTool, { path: path.join(wt.parentRoot, 'src', 'a.ts') }, ctx)).toEqual({ action: 'allow' });
  });

  it('also denies writes outside the worktree, regardless of the permission mode', async () => {
    const ctx = makeCtx(wt.cwd);
    expect((await worktreeGuardHook(wt)(writeTool, { path: path.resolve('/other/project/new.ts'), content: 'x' }, ctx)).action).toBe('deny');
  });

  it('leaves project memory permission checks to the shared provider', async () => {
    expect(await worktreeGuardHook(wt)(memoryTool, { action: 'save', content: 'project preference' }, makeCtx(wt.cwd))).toEqual({ action: 'allow' });
  });
});
