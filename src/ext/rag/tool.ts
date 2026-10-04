/**
 * search_code 工具：按自然语言或标识符做相关性检索（BM25），返回最相关的代码片段（带行号）。
 * 与 grep 互补：grep 精确匹配；search_code 适合"登录逻辑在哪""哪里处理重试"这类模糊问题。
 */
import { z } from 'zod';
import { defineTool, textResult, toolErrorResult, type ToolResult } from '../../tools/tool.js';
import type { CodeHit, CodeIndex } from './code-index.js';

export const CODE_INDEX_KEY = 'codeIndex';
/** 每个片段最多展示的行数 */
const SNIPPET_LINES = 30;

function renderHit(h: CodeHit): string {
  const lines = h.text.split('\n').slice(0, SNIPPET_LINES);
  const body = lines.map((l, i) => `${String(h.startLine + i).padStart(5)}  ${l}`).join('\n');
  return `── ${h.file}:${h.startLine}-${h.startLine + lines.length - 1}  (score ${h.score.toFixed(2)})\n${body}`;
}

export const searchCodeTool = defineTool({
  name: 'search_code',
  description:
    '在代码库中做相关性检索（BM25，支持自然语言、标识符、camelCase 子词），返回最相关的代码片段和行号。' +
    '适合不知道确切关键字时定位代码；已知确切文本时用 grep 更快。',
  parameters: z.object({
    query: z.string().min(1).describe('检索内容，如 "retry after rate limit" 或 "parseSkillFile"'),
    limit: z.number().int().min(1).max(20).optional().describe('返回片段数，默认 6'),
    path: z.string().optional().describe('只在该子目录下检索（相对工作目录）'),
  }),
  isReadOnly: true,
  isConcurrencySafe: true,
  permission: { kind: 'read' },
  async execute(args, ctx): Promise<ToolResult> {
    const index = ctx.services.get<CodeIndex>(CODE_INDEX_KEY);
    if (!index) return toolErrorResult('search_code', '当前会话未启用代码索引');
    const hits = await index.search(args.query, {
      signal: ctx.signal,
      ...(args.limit ? { limit: args.limit } : {}),
      ...(args.path ? { pathPrefix: args.path } : {}),
    });
    const { files, chunks } = index.stats;
    const warning = index.warning ? `\n${index.warning}` : '';
    if (hits.length === 0) return textResult(`没有找到相关代码（已索引 ${files} 个文件 / ${chunks} 个片段）。可以换个说法，或用 grep 精确搜索。${warning}`);
    return textResult(`${hits.map(renderHit).join('\n\n')}\n\n（已索引 ${files} 个文件）${warning}`, { hits: hits.length });
  },
});
