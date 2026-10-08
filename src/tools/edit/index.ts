/**
 * edit 工具：精确字符串替换（核心逻辑见 ../file-ops.ts）。
 * 约束：同一会话内文件必须先被 read 读过，且自读后未被外部修改；写回保持原有换行风格。
 */
import { z } from 'zod';
import { resolveUserPath } from '../../core/paths.js';
import { applyEdit, commitWrite, loadForWrite } from '../file-ops.js';
import { defineTool, textResult, toolErrorResult, type ToolResult } from '../tool.js';
import { appendDiagnostics } from '../lsp/diagnostics.js';

const parameters = z.object({
  path: z.string().describe('文件路径；相对路径基于当前工作目录解析'),
  old_string: z.string().describe('要被替换的原始字符串，必须在文件中存在'),
  new_string: z.string().describe('替换后的新字符串'),
  replace_all: z.boolean().default(false).describe('为 true 时替换所有出现；默认要求 old_string 恰好出现一次'),
});

export const editTool = defineTool({
  name: 'edit',
  description:
    '对文件做精确字符串替换。使用前必须先用 read 工具读取该文件，且文件自读取后未被外部修改。' +
    'old_string 默认必须在文件中恰好出现一次；多次出现时应提供更长的唯一上下文，或设置 replace_all=true。' +
    '写回时保持文件原有换行风格（CRLF/LF）。同一文件多处修改请用 multi_edit。',
  parameters,
  isReadOnly: false,
  isConcurrencySafe: false,
  permission: { kind: 'edit', target: (args, ctx) => resolveUserPath(ctx.cwd, args.path) },

  async execute(args, ctx): Promise<ToolResult> {
    const abs = resolveUserPath(ctx.cwd, args.path);
    const loaded = await loadForWrite(abs, ctx.services);
    if (!loaded.ok) return toolErrorResult('edit', loaded.error);
    const { file } = loaded;
    const edited = applyEdit(file.content, args);
    if (!edited.ok) return toolErrorResult('edit', `${abs}: ${edited.error}`);
    const out = await commitWrite(abs, file.content, edited.content, file.crlf, ctx.services, {
      expectedExists: true,
      signal: ctx.signal,
      diagnostics: true,
    });
    return appendDiagnostics(
      textResult(`edit 完成：${abs}，替换 ${edited.count} 处（+${out.diff.added} -${out.diff.removed}）。`, {
        path: abs,
        replacements: edited.count,
        bytesBefore: file.bytes,
        bytesAfter: out.bytes,
        // resume 时据此重建"已读/未被外部修改"状态
        fileState: out.fileState,
        diff: out.diff,
      }),
      out.diagnostics,
      abs,
      ctx.services,
    );
  },
});
