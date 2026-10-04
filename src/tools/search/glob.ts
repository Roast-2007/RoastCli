/**
 * glob 工具：按 glob 模式查找文件，按修改时间倒序（最近改动的在前）。
 * 有 ripgrep 时用 `rg --files`（尊重 .gitignore），否则 tinyglobby 回退。
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { resolveUserPath } from '../../core/paths.js';
import { defineTool, textResult, toolErrorResult, type ToolResult } from '../tool.js';
import { locateRipgrep, runRipgrep } from './rg.js';
import { walkFiles } from './walk.js';

const MAX_RESULTS = 500;
const MAX_STAT = 5000;

const parameters = z.object({
  pattern: z.string().describe('glob 模式，如 "**/*.ts"、"src/**/*.test.tsx"'),
  path: z.string().optional().describe('搜索根目录，默认当前工作目录'),
});

async function listWithRg(rg: string, root: string, pattern: string, signal: AbortSignal): Promise<string[]> {
  const r = await runRipgrep(rg, ['--files', '--hidden', '--glob', '!.git', '--glob', '!node_modules', '--glob', pattern], root, signal);
  if (r.code !== 0 && r.code !== 1) throw new Error(r.stderr.trim() || `rg 退出码 ${r.code}`);
  return r.stdout.split(/\r?\n/).filter(Boolean);
}

async function byMtimeDesc(root: string, files: string[]): Promise<string[]> {
  const head = files.slice(0, MAX_STAT);
  const stamped = await Promise.all(
    head.map(async (f) => {
      try {
        return { f, t: (await stat(path.join(root, f))).mtimeMs };
      } catch {
        return { f, t: 0 };
      }
    }),
  );
  return stamped.sort((a, b) => b.t - a.t).map((s) => s.f);
}

export const globTool = defineTool({
  name: 'glob',
  description:
    '按 glob 模式查找文件路径（如 "**/*.ts"），结果按修改时间倒序。默认忽略 .git 与 .gitignore 中的路径（有 ripgrep 时）。' +
    `最多返回 ${MAX_RESULTS} 条。找内容请用 grep。`,
  parameters,
  isReadOnly: true,
  isConcurrencySafe: true,
  permission: { kind: 'read', target: (args, ctx) => resolveUserPath(ctx.cwd, args.path ?? '.') },

  async execute(args, ctx): Promise<ToolResult> {
    const root = resolveUserPath(ctx.cwd, args.path ?? '.');
    const rg = locateRipgrep().path;
    let files: string[];
    try {
      files = rg ? await listWithRg(rg, root, args.pattern, ctx.signal) : await walkFiles(root, args.pattern);
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      return toolErrorResult('glob', `搜索失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (files.length === 0) return textResult(`没有匹配 ${args.pattern} 的文件（根目录 ${root}）`, { count: 0 });
    const sorted = await byMtimeDesc(root, files.map((f) => f.split(path.sep).join('/')));
    const shown = sorted.slice(0, MAX_RESULTS);
    const more = files.length > shown.length ? `\n[共 ${files.length} 个，仅显示最近修改的 ${shown.length} 个]` : '';
    return textResult(`${shown.join('\n')}${more}`, { count: files.length, root });
  },
});
