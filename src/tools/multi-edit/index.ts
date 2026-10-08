/**
 * multi_edit 工具：对同一文件按顺序应用多处替换，全部成功才写回（原子）。
 */
import { z } from 'zod';
import { resolveUserPath } from '../../core/paths.js';
import { applyEdit, commitWrite, loadForWrite } from '../file-ops.js';
import { defineTool, textResult, toolErrorResult, type ToolResult } from '../tool.js';
import { appendDiagnostics } from '../lsp/diagnostics.js';

const editSchema = z.object({
  old_string: z.string().describe('要被替换的原始字符串（基于前序替换之后的内容）'),
  new_string: z.string().describe('替换后的新字符串'),
  replace_all: z.boolean().default(false).describe('替换所有出现'),
});

const parameters = z.object({
  path: z.string().describe('文件路径；相对路径基于当前工作目录解析'),
  edits: z.array(editSchema).min(1).describe('按顺序应用的替换列表；任何一处失败则整体不写入'),
});

export const multiEditTool = defineTool({
  name: 'multi_edit',
  description:
    '对同一文件按顺序应用多处精确替换，全部成功才写回（原子操作）。前置条件同 edit：必须先 read 且文件未被外部修改。' +
    '每一处替换基于前一处替换之后的内容进行匹配。',
  parameters,
  isReadOnly: false,
  isConcurrencySafe: false,
  permission: { kind: 'edit', target: (args, ctx) => resolveUserPath(ctx.cwd, args.path) },

  async execute(args, ctx): Promise<ToolResult> {
    const abs = resolveUserPath(ctx.cwd, args.path);
    const loaded = await loadForWrite(abs, ctx.services);
    if (!loaded.ok) return toolErrorResult('multi_edit', loaded.error);
    const { file } = loaded;
    let content = file.content;
    let total = 0;
    for (const [i, edit] of args.edits.entries()) {
      const r = applyEdit(content, edit);
      if (!r.ok) return toolErrorResult('multi_edit', `第 ${i + 1} 处替换失败（未写入任何改动）：${r.error}`);
      content = r.content;
      total += r.count;
    }
    const out = await commitWrite(abs, file.content, content, file.crlf, ctx.services, {
      expectedExists: true,
      signal: ctx.signal,
      diagnostics: true,
    });
    return appendDiagnostics(
      textResult(`multi_edit 完成：${abs}，${args.edits.length} 组替换共 ${total} 处（+${out.diff.added} -${out.diff.removed}）。`, {
        path: abs,
        replacements: total,
        bytesBefore: file.bytes,
        bytesAfter: out.bytes,
        fileState: out.fileState,
        diff: out.diff,
      }),
      out.diagnostics,
      abs,
      ctx.services,
    );
  },
});
