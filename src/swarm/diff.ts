import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isPathInside } from '../core/paths.js';
export interface DiffTarget { cwd: string; base?: string }
export interface DiffReview { stat: string; diff: string; files: number; added: number; removed: number; truncated?: boolean }
const MAX_DIFF = 2_000_000;
async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => execFile('git', ['--no-pager', '-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args], { cwd, signal, windowsHide: true, timeout: 15000, maxBuffer: 8_000_000 }, (error, out) => error ? reject(error) : resolve(out)));
}
/** Purely reads the working tree; never touches its index, HEAD or snapshot baseline. */
export async function readDiff(target: DiffTarget, signal?: AbortSignal): Promise<DiffReview> {
  signal?.throwIfAborted();
  if (target.base && !/^[a-f\d]{40,64}$/i.test(target.base)) throw new Error('无效的 worktree 基线');
  const common = ['diff', '--no-ext-diff', '--no-textconv', ...(target.base ? [target.base] : [])];
  const [stat, numstat, diff] = await Promise.all([git(target.cwd, [...common, '--stat', '--'], signal), git(target.cwd, [...common, '--numstat', '--'], signal), git(target.cwd, [...common, '--src-prefix=a/', '--dst-prefix=b/', '--'], signal)]);
  let added = 0, removed = 0, files = 0, extraStat = '', extraDiff = '';
  for (const line of numstat.split('\n').filter(Boolean)) { const counts = line.split('\t'); added += Number(counts[0]) || 0; removed += Number(counts[1]) || 0; files++; }
  // Baseline review includes files created by a writer without staging them.
  if (target.base) {
    const root = (await git(target.cwd, ['rev-parse', '--show-toplevel'], signal)).trim();
    const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.', ':!.roast', ':!node_modules'], signal)).split('\0').filter(Boolean);
    for (const name of untracked) {
      signal?.throwIfAborted(); const abs = path.resolve(root, name);
      if (!isPathInside(root, abs) || (await lstat(abs)).isSymbolicLink()) continue;
      const info = await lstat(abs); files++;
      if (info.size > MAX_DIFF || extraDiff.length >= MAX_DIFF) { extraStat += `${name} | 内容过大\n`; continue; }
      const bytes = await readFile(abs, { signal });
      if (bytes.includes(0)) { extraStat += `${name} | Binary\n`; continue; }
      const lines = bytes.toString('utf8').split('\n'); if (lines.at(-1) === '') lines.pop(); added += lines.length;
      extraStat += `${name} | +${lines.length}\n`;
      extraDiff += `diff --git a/${name} b/${name}\nnew file\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}\n`;
    }
  }
  const full = diff + extraDiff;
  return { stat: stat + extraStat, diff: full.slice(0, MAX_DIFF), files, added, removed, ...(full.length > MAX_DIFF ? { truncated: true } : {}) };
}
