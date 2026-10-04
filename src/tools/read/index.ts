/**
 * read 工具：按行读取文本文件，输出 `<行号>\t<内容>`（与 Claude Code 一致）。
 * 检测二进制（前 8KB 含 NUL）拒绝读取；读取后记录 read-state 供 edit 校验。
 */
import { readFile, stat } from 'node:fs/promises';
import { resolveUserPath } from '../../core/paths.js';
import { z } from 'zod';
import { defineTool, textResult, toolErrorResult, type ToolResult } from '../tool.js';
import { getFileStateStore, sha1Of } from '../fs-state.js';

const DEFAULT_LIMIT = 2000;
const MAX_LINE_CHARS = 2000;
const BINARY_SNIFF_BYTES = 8192;

const parameters = z.object({
  path: z.string().describe('文件路径；相对路径基于当前工作目录解析'),
  offset: z.number().int().min(1).optional().describe('起始行号（1-based），默认从第 1 行开始'),
  limit: z.number().int().min(1).optional().describe(`读取行数，默认 ${DEFAULT_LIMIT}`),
});

export const readTool = defineTool({
  name: 'read',
  description:
    '读取文本文件内容，每行以 `<行号>\\t<内容>` 格式输出。' +
    '支持 offset/limit 分页；单行超过 2000 字符会截断；二进制文件（如图片、可执行文件）不支持，会返回错误。',
  parameters,
  isReadOnly: true,
  isConcurrencySafe: true,
  permission: { kind: 'read', target: (args, ctx) => resolveUserPath(ctx.cwd, args.path) },

  async execute(args, ctx): Promise<ToolResult> {
    const abs = resolveUserPath(ctx.cwd, args.path);

    let st;
    try {
      st = await stat(abs);
    } catch {
      return toolErrorResult('read', `文件不存在: ${abs}`);
    }
    if (st.isDirectory()) {
      return toolErrorResult('read', `路径是目录而非文件: ${abs}`);
    }

    const buf = await readFile(abs);
    const sniff = buf.subarray(0, BINARY_SNIFF_BYTES);
    if (sniff.includes(0)) {
      return toolErrorResult('read', `二进制文件不支持读取: ${abs}（前 8KB 检测到 NUL 字节）`);
    }

    const content = buf.toString('utf8');
    const lines = content.split('\n');
    const offset = args.offset ?? 1;
    const limit = args.limit ?? DEFAULT_LIMIT;

    if (offset > lines.length && lines.length > 0) {
      return toolErrorResult('read', `offset=${offset} 超出文件总行数（共 ${lines.length} 行）`);
    }

    const start = offset - 1;
    const end = Math.min(start + limit, lines.length);
    const out: string[] = [];
    for (let i = start; i < end; i++) {
      let line = lines[i] ?? '';
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.length > MAX_LINE_CHARS) {
        line = `${line.slice(0, MAX_LINE_CHARS)} [... 本行截断，原长 ${line.length} 字符]`;
      }
      out.push(`${i + 1}\t${line}`);
    }
    if (end < lines.length) {
      out.push(`\n[输出已截断：文件共 ${lines.length} 行，本次显示第 ${offset}-${end} 行。使用 offset 参数继续读取。]`);
    }

    // 记录 read-state，供 edit 校验"先读后改 / 外部修改"
    const fileState = { mtimeMs: st.mtimeMs, size: st.size, sha1: sha1Of(buf) };
    getFileStateStore(ctx.services).record(abs, fileState);

    return textResult(out.join('\n'), {
      path: abs,
      totalLines: lines.length,
      offset,
      returnedLines: end - start,
      // resume 时据此重建"已读/未被外部修改"状态
      fileState,
    });
  },
});
