/**
 * write 工具：创建新文件或整体覆盖已有文件。
 * 覆盖已有文件时要求先 read 过且未被外部修改（防止盲写丢失内容），并保持其原换行风格。
 */
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { resolveUserPath } from '../../core/paths.js';
import { commitWrite, loadForWrite } from '../file-ops.js';
import { defineTool, textResult, toolErrorResult, type ToolResult } from '../tool.js';
import { appendDiagnostics } from '../lsp/diagnostics.js';

const parameters = z.object({
  path: z.string().describe('文件路径；相对路径基于当前工作目录解析；父目录不存在会自动创建'),
  content: z.string().describe('完整文件内容'),
});

export const writeTool = defineTool({
  name: 'write',
  description:
    '写入完整文件内容：文件不存在则创建（自动创建父目录）；已存在则整体覆盖——覆盖前必须先用 read 读取且文件未被外部修改。' +
    '修改已有文件的局部内容应优先使用 edit / multi_edit。',
  parameters,
  isReadOnly: false,
  isConcurrencySafe: false,
  permission: { kind: 'edit', target: (args, ctx) => resolveUserPath(ctx.cwd, args.path) },

  async execute(args, ctx): Promise<ToolResult> {
    const abs = resolveUserPath(ctx.cwd, args.path);
    const exists = existsSync(abs);
    let before = '';
    let crlf = false;
    if (exists) {
      const loaded = await loadForWrite(abs, ctx.services);
      if (!loaded.ok) return toolErrorResult('write', loaded.error);
      before = loaded.file.content;
      crlf = loaded.file.crlf;
    }
    const after = crlf ? args.content.replace(/\r\n/g, '\n') : args.content;
    const out = await commitWrite(abs, before, after, crlf, ctx.services, {
      expectedExists: exists,
      signal: ctx.signal,
      diagnostics: true,
    });
    const verb = exists ? '覆盖' : '创建';
    return appendDiagnostics(
      textResult(`write 完成：${verb} ${abs}（${out.bytes} 字节，+${out.diff.added} -${out.diff.removed}）。`, {
        path: abs,
        created: !exists,
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
