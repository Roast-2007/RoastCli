import { roastHome } from '../core/config.js';
import { terminalText } from '../core/terminal-text.js';
import { WorktreeManager, type SavedWorktree } from '../swarm/worktree.js';

export async function listWorktrees(cwd: string, home = roastHome()): Promise<SavedWorktree[]> {
  return new WorktreeManager({ runId: 'maintenance', home }).list(cwd);
}

/** 只删除不再运行且相对派生基线无改动的工作区；检查失败时保留。 */
export async function pruneWorktrees(cwd: string, home = roastHome()): Promise<{ removed: string[]; kept: string[]; active: string[] }> {
  const removed: string[] = []; const kept: string[] = []; const active: string[] = [];
  for (const wt of await listWorktrees(cwd, home)) {
    if (wt.active) { active.push(wt.root); continue; }
    const mgr = new WorktreeManager({ runId: wt.runId, home });
    try {
      if ((await mgr.changedFiles(wt)).length) { kept.push(wt.root); continue; }
      await mgr.remove(wt);
      removed.push(wt.root);
    } catch { kept.push(wt.root); }
  }
  return { removed, kept, active };
}

export function savedWorktreesText(paths: string[]): string {
  return paths.length ? `以下 worktree 仍有未合并改动（或未能确认已清理），已保留：\n${paths.map((p) => `- ${terminalText(p)}`).join('\n')}\n用 roast worktrees list 查看；roast worktrees prune 只清理无改动且已结束的工作区。\n` : '';
}
