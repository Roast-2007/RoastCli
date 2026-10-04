/**
 * ls 工具：列出目录内容（目录在前、带 / 后缀；文件带大小），默认跳过 .git / node_modules。
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import picomatch from 'picomatch';
import { z } from 'zod';
import { resolveUserPath } from '../../core/paths.js';
import { defineTool, textResult, toolErrorResult, type ToolResult } from '../tool.js';

const MAX_ENTRIES = 500;
const ALWAYS_SKIP = new Set(['.git', 'node_modules']);

const parameters = z.object({
  path: z.string().optional().describe('目录路径，默认当前工作目录'),
  ignore: z.array(z.string()).optional().describe('要忽略的 glob 模式（按条目名匹配），如 ["*.log", "dist"]'),
});

function humanSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

export const lsTool = defineTool({
  name: 'ls',
  description: `列出目录内容：子目录在前（以 / 结尾），文件附大小。默认跳过 .git 与 node_modules，最多 ${MAX_ENTRIES} 项。`,
  parameters,
  isReadOnly: true,
  isConcurrencySafe: true,
  permission: { kind: 'read', target: (args, ctx) => resolveUserPath(ctx.cwd, args.path ?? '.') },

  async execute(args, ctx): Promise<ToolResult> {
    const dir = resolveUserPath(ctx.cwd, args.path ?? '.');
    const isIgnored = args.ignore?.length ? picomatch(args.ignore, { dot: true }) : () => false;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      return toolErrorResult('ls', `无法读取目录 ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const kept = entries.filter((e) => !ALWAYS_SKIP.has(e.name) && !isIgnored(e.name));
    const dirs = kept.filter((e) => e.isDirectory()).map((e) => `${e.name}/`).sort();
    const files = await Promise.all(
      kept
        .filter((e) => !e.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(async (e) => {
          try {
            return `${e.name}  ${humanSize((await stat(path.join(dir, e.name))).size)}`;
          } catch {
            return e.name;
          }
        }),
    );
    const all = [...dirs, ...files];
    if (all.length === 0) return textResult(`${dir}（空目录）`, { count: 0 });
    const shown = all.slice(0, MAX_ENTRIES);
    const more = all.length > shown.length ? `\n[共 ${all.length} 项，仅显示前 ${shown.length} 项]` : '';
    return textResult(`${dir}\n${shown.join('\n')}${more}`, { count: all.length });
  },
});
