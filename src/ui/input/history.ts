/**
 * 输入历史持久化：~/.roast/projects/<hash>/history.jsonl（每行一个 JSON 字符串，保留最近 MAX 条）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { projectSettingsPath } from '../../tools/permissions/settings.js';

const MAX = 500;

export function historyPath(cwd: string): string {
  return path.join(path.dirname(projectSettingsPath(cwd)), 'history.jsonl');
}

export function loadHistory(cwd: string): string[] {
  const file = historyPath(cwd);
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as unknown)
      .filter((x): x is string => typeof x === 'string')
      .slice(-MAX);
  } catch {
    return [];
  }
}

export function appendHistory(cwd: string, entry: string): void {
  if (!entry.trim()) return;
  try {
    const file = historyPath(cwd);
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // 历史写失败不影响使用
  }
}
