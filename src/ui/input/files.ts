/**
 * @ 文件引用的候选：懒加载工作区文件列表（排除 node_modules / .git / .roast），子序列模糊匹配。
 * 评分：连续命中、命中文件名部分、路径越短越优先。
 */
import { glob } from 'tinyglobby';

const MAX_FILES = 20_000;
const IGNORE = ['**/node_modules/**', '**/.git/**', '**/.roast/**', '**/dist/**', '**/logs/**'];

export function fuzzyScore(query: string, candidate: string): number | null {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  if (!q) return 0;
  const base = c.lastIndexOf('/') + 1;
  let score = 0;
  let ci = 0;
  let prev = -2;
  for (const ch of q) {
    const found = c.indexOf(ch, ci);
    if (found === -1) return null;
    score += found === prev + 1 ? 5 : 1;
    if (found >= base) score += 2;
    prev = found;
    ci = found + 1;
  }
  return score * 100 - candidate.length;
}

export function rankFiles(query: string, files: readonly string[], limit = 8): string[] {
  return files
    .map((f) => ({ f, s: fuzzyScore(query, f) }))
    .filter((x): x is { f: string; s: number } => x.s !== null)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.f);
}

export class FileIndex {
  private files: string[] | null = null;
  private loading: Promise<void> | null = null;

  constructor(private readonly cwd: string) {}

  /** 触发后台加载；加载完成前 match 返回空 */
  warm(): void {
    this.loading ??= glob('**/*', { cwd: this.cwd, ignore: IGNORE, onlyFiles: true, dot: false })
      .then((list) => {
        this.files = list.slice(0, MAX_FILES).sort();
      })
      .catch(() => {
        this.files = [];
      });
  }

  match(query: string, limit = 8): string[] {
    this.warm();
    return this.files ? rankFiles(query, this.files, limit) : [];
  }
}
