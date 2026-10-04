/**
 * 状态栏的附加信息：git 分支（直接读 HEAD 文件，不起子进程）与按模型定价估算的费用。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
export { costOf } from '../core/usage-cost.js';

/** 当前分支名；detached HEAD 返回短 hash；不在 git 仓库中返回 null */
export function gitBranch(cwd: string): string | null {
  try {
    for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
      const dotGit = path.join(dir, '.git');
      if (existsSync(dotGit)) {
        let gitDir = dotGit;
        if (statSync(dotGit).isFile()) {
          const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
          if (!m) return null;
          gitDir = path.resolve(dir, m[1]!.trim());
        }
        const head = readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
        const ref = /^ref: refs\/heads\/(.+)$/.exec(head);
        return ref ? ref[1]! : head.slice(0, 7);
      }
      if (path.dirname(dir) === dir) return null;
    }
  } catch {
    return null;
  }
}

export function formatCost(usd: number): string {
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}
