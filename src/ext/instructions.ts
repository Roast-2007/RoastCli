/**
 * 项目/用户指令文件（ROAST.md / AGENTS.md / CLAUDE.md）：
 * - 用户级：<roastHome>/ROAST.md（个人偏好，跨项目）
 * - 项目级：从仓库根（含 .git 的最近祖先；找不到则只看 cwd）向下到 cwd，
 *   每层取第一个存在的 ROAST.md > AGENTS.md > CLAUDE.md
 * 渲染为系统 prompt 的稳定前缀 section（不随 step 变化，利于前缀缓存）。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const INSTRUCTION_FILE_NAMES = ['ROAST.md', 'AGENTS.md', 'CLAUDE.md'] as const;
export const DEFAULT_INSTRUCTIONS_BUDGET = 40_000;

export interface InstructionFile {
  scope: 'user' | 'project';
  path: string;
  text: string;
}

function readIfExists(file: string): string | null {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  } catch {
    return null;
  }
}

function firstInDir(dir: string): { path: string; text: string } | null {
  for (const name of INSTRUCTION_FILE_NAMES) {
    const file = path.join(dir, name);
    const text = readIfExists(file);
    if (text !== null && text.trim()) return { path: file, text: text.trim() };
  }
  return null;
}

/** cwd 与仓库根之间的目录链（根在前）；无仓库时只有 cwd */
function projectDirs(cwd: string): string[] {
  const chain: string[] = [];
  let dir = path.resolve(cwd);
  for (;;) {
    chain.unshift(dir);
    if (existsSync(path.join(dir, '.git'))) return chain;
    const parent = path.dirname(dir);
    if (parent === dir) return [path.resolve(cwd)];
    dir = parent;
  }
}

export function findInstructionFiles(cwd: string, opts: { home: string }): InstructionFile[] {
  const out: InstructionFile[] = [];
  const userText = readIfExists(path.join(opts.home, 'ROAST.md'));
  if (userText !== null && userText.trim()) {
    out.push({ scope: 'user', path: path.join(opts.home, 'ROAST.md'), text: userText.trim() });
  }
  for (const dir of projectDirs(cwd)) {
    const found = firstInDir(dir);
    if (found) out.push({ scope: 'project', ...found });
  }
  return out;
}

/** 渲染为 section 文本；超出预算的部分截断并标注 */
export function renderInstructions(files: InstructionFile[], budget = DEFAULT_INSTRUCTIONS_BUDGET): string {
  if (files.length === 0) return '';
  let remaining = budget;
  const parts: string[] = [];
  for (const f of files) {
    if (remaining <= 0) {
      parts.push(`<instructions source="${f.path}">（预算耗尽，已省略）</instructions>`);
      continue;
    }
    const body = f.text.length > remaining ? `${f.text.slice(0, remaining)}\n[... 已截断 ...]` : f.text;
    remaining -= f.text.length;
    parts.push(`<instructions scope="${f.scope}" source="${f.path}">\n${body}\n</instructions>`);
  }
  return `The following instructions were provided by the user and the project. Follow them; more specific (deeper) files take precedence.\n\n${parts.join('\n\n')}`;
}
