/**
 * grep 工具：正则搜索文件内容（ripgrep 语义）。无 ripgrep 时回退为 JS 逐行匹配（不支持 type/上下文/多行）。
 */
import path from 'node:path';
import { z } from 'zod';
import { resolveUserPath } from '../../core/paths.js';
import { defineTool, textResult, toolErrorResult, type ToolResult } from '../tool.js';
import { truncateOutput } from '../bash/output.js';
import { locateRipgrep, runRipgrep } from './rg.js';
import { grepFiles, walkFiles } from './walk.js';

const DEFAULT_HEAD_LIMIT = 250;

const parameters = z.object({
  pattern: z.string().describe('正则表达式（ripgrep 语法）'),
  path: z.string().optional().describe('搜索的文件或目录，默认当前工作目录'),
  glob: z.string().optional().describe('只搜索匹配该 glob 的文件，如 "*.ts"、"src/**/*.tsx"'),
  type: z.string().optional().describe('文件类型（ripgrep --type），如 ts、py、rust'),
  output_mode: z
    .enum(['files_with_matches', 'content', 'count'])
    .default('files_with_matches')
    .describe('files_with_matches（默认，仅文件名）/ content（匹配行）/ count（每文件计数）'),
  case_insensitive: z.boolean().default(false).describe('忽略大小写'),
  context: z.number().int().min(0).max(20).optional().describe('content 模式下匹配行前后各显示的行数'),
  multiline: z.boolean().default(false).describe('允许跨行匹配（. 匹配换行）'),
  head_limit: z.number().int().min(1).max(5000).default(DEFAULT_HEAD_LIMIT).describe('最多返回的行数/条目数'),
});

type Args = z.infer<typeof parameters>;

function rgArgs(args: Args, target: string): string[] {
  const out = ['--color', 'never', '--hidden', '--glob', '!.git', '--glob', '!node_modules', '--max-columns', '500'];
  if (args.output_mode === 'files_with_matches') out.push('-l');
  else if (args.output_mode === 'count') out.push('-c');
  else out.push('-n', '--no-heading');
  if (args.case_insensitive) out.push('-i');
  if (args.multiline) out.push('-U', '--multiline-dotall');
  if (args.context !== undefined && args.output_mode === 'content') out.push('-C', String(args.context));
  if (args.glob) out.push('--glob', args.glob);
  if (args.type) out.push('--type', args.type);
  out.push('-e', args.pattern, '--', target);
  return out;
}

async function fallback(args: Args, root: string, signal: AbortSignal): Promise<string[]> {
  const re = new RegExp(args.pattern, args.case_insensitive ? 'i' : '');
  const files = await walkFiles(root, args.glob ? (args.glob.includes('/') ? args.glob : `**/${args.glob}`) : '**/*');
  const matches = await grepFiles(root, files, re, signal, args.head_limit * 20);
  if (args.output_mode === 'content') return matches.map((m) => `${m.file}:${m.line}:${m.text}`);
  const counts = new Map<string, number>();
  for (const m of matches) counts.set(m.file, (counts.get(m.file) ?? 0) + 1);
  return args.output_mode === 'count' ? [...counts].map(([f, n]) => `${f}:${n}`) : [...counts.keys()];
}

export const grepTool = defineTool({
  name: 'grep',
  description:
    '在文件内容中搜索正则表达式（ripgrep 语义，尊重 .gitignore）。默认只返回匹配的文件名；' +
    'output_mode=content 返回 "文件:行号:内容"，可配合 context；用 glob / type 缩小范围。' +
    `结果默认最多 ${DEFAULT_HEAD_LIMIT} 行（head_limit）。`,
  parameters,
  isReadOnly: true,
  isConcurrencySafe: true,
  permission: { kind: 'read', target: (args, ctx) => resolveUserPath(ctx.cwd, args.path ?? '.') },

  async execute(args, ctx): Promise<ToolResult> {
    const target = resolveUserPath(ctx.cwd, args.path ?? '.');
    const rg = locateRipgrep().path;
    let lines: string[];
    try {
      if (rg) {
        // 工作区内用相对路径：输出更短、更省 token
        const rel = path.relative(ctx.cwd, target);
        const shown = rel === '' ? '.' : rel.startsWith('..') || path.isAbsolute(rel) ? target : rel;
        const r = await runRipgrep(rg, rgArgs(args, shown), ctx.cwd, ctx.signal);
        if (r.code === 2 && !r.stdout) return toolErrorResult('grep', `ripgrep 出错: ${r.stderr.trim()}`);
        lines = r.stdout.split(/\r?\n/).filter(Boolean);
      } else {
        lines = await fallback(args, target, ctx.signal);
      }
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      return toolErrorResult('grep', `搜索失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (lines.length === 0) return textResult(`没有找到匹配 /${args.pattern}/ 的内容`, { count: 0 });
    const shown = lines.slice(0, args.head_limit);
    const more = lines.length > shown.length ? `\n[共 ${lines.length} 行，已截断到 ${shown.length} 行；可缩小范围或调大 head_limit]` : '';
    return textResult(truncateOutput(shown.join('\n')) + more, { count: lines.length, mode: args.output_mode });
  },
});
