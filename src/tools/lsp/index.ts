import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { defineTool, textResult, toolErrorResult } from '../tool.js';
import { languageService, positionOf, lineColumn } from './typescript.js';
import { canonicalPath, isPathInside, resolveUserPath } from '../../core/paths.js';
import { commitWrite } from '../file-ops.js';
import { sha1Of } from '../fs-state.js';

const location = {
  path: z.string().min(1),
  line: z.number().int().min(1),
  column: z.number().int().min(1).describe('1-based UTF-16 列号'),
};
export const findReferencesTool = defineTool({
  name: 'find_references',
  description: '通过 TypeScript/JavaScript 语言服务查找指定符号的语义引用（含导入、别名与定义，区分同名但不同作用域的符号）。',
  parameters: z.object({ ...location, limit: z.number().int().min(1).max(1000).default(200) }),
  isReadOnly: true,
  isConcurrencySafe: true,
  permission: { kind: 'read', target: (args, ctx) => resolveUserPath(ctx.cwd, args.path) },
  async execute(args, ctx) {
    ctx.signal.throwIfAborted();
    const ls = await languageService(ctx.cwd, args.path);
    try {
      const refs = ls.service.getReferencesAtPosition(ls.abs, positionOf(ls.text(ls.abs), args.line, args.column)) ?? [];
      const internal = refs.filter((ref) => isPathInside(ctx.cwd, ref.fileName));
      await ctx.checkTargets?.([...new Set(internal.map((ref) => ref.fileName))]);
      const references = internal
        .slice(0, args.limit)
        .map((ref) => ({
          path: path.relative(ctx.cwd, ref.fileName),
          ...lineColumn(ls.text(ref.fileName), ref.textSpan.start),
          write: ref.isWriteAccess,
        }));
      return textResult(JSON.stringify({ references, total: internal.length, truncated: internal.length > args.limit }), {
        count: internal.length,
      });
    } finally {
      ls.service.dispose();
    }
  },
});

export const renameSymbolTool = defineTool({
  name: 'rename_symbol',
  description:
    '通过 TS/JS 语言服务规划跨文件符号重命名。默认只预览；apply=true 校验所有路径权限与文件内容后应用，保持 CRLF。不会替换字符串或注释中的同名文本。',
  parameters: z.object({
    ...location,
    new_name: z.string().regex(/^[$\p{ID_Start}_][$\p{ID_Continue}]*$/u),
    apply: z.boolean().default(false),
  }),
  isReadOnly: false,
  isConcurrencySafe: false,
  permission: {
    kind: 'edit',
    kindFor: (args) => (args.apply ? 'edit' : 'read'),
    target: (args, ctx) => resolveUserPath(ctx.cwd, args.path),
  },
  async execute(args, ctx) {
    ctx.signal.throwIfAborted();
    const ls = await languageService(ctx.cwd, args.path);
    try {
      const position = positionOf(ls.text(ls.abs), args.line, args.column);
      if (!ls.validIdentifier(args.new_name)) return toolErrorResult('rename_symbol', '新名称必须是有效的非关键字标识符；未做修改');
      const info = ls.service.getRenameInfo(ls.abs, position, { allowRenameOfImportPath: false });
      if (!info.canRename) return toolErrorResult('rename_symbol', info.localizedErrorMessage);
      const locations = ls.service.findRenameLocations(ls.abs, position, false, false, { providePrefixAndSuffixTextForRename: true }) ?? [];
      if (!locations.length) return toolErrorResult('rename_symbol', '没有可重命名的引用');
      const files = new Map<
        string,
        { abs: string; before: string; after: string; edits: Array<{ start: number; length: number; text: string }> }
      >();
      for (const loc of locations) {
        if (!isPathInside(ctx.cwd, loc.fileName) || /(?:^|[\\/])(?:node_modules|\.git)(?:[\\/]|$)/.test(loc.fileName))
          return toolErrorResult('rename_symbol', '重命名涉及工作区外或依赖文件；未做修改');
        const key = canonicalPath(loc.fileName);
        const file = files.get(key) ?? { abs: loc.fileName, before: ls.text(loc.fileName), after: '', edits: [] };
        file.edits.push({
          ...loc.textSpan,
          length: loc.textSpan.length,
          text: `${loc.prefixText ?? ''}${args.new_name}${loc.suffixText ?? ''}`,
        });
        files.set(key, file);
      }
      for (const file of files.values()) {
        file.after = file.before;
        for (const edit of file.edits.sort((a, b) => b.start - a.start))
          file.after = file.after.slice(0, edit.start) + edit.text + file.after.slice(edit.start + edit.length);
      }
      const plan = [...files.values()].map((file) => ({
        path: path.relative(ctx.cwd, file.abs),
        edits: file.edits.map((edit) => ({ ...lineColumn(file.before, edit.start), length: edit.length, text: edit.text })),
      }));
      if (!args.apply) await ctx.checkTargets?.([...files.values()].map((file) => file.abs));
      if (!args.apply) return textResult(JSON.stringify({ applied: false, symbol: info.displayName, files: plan }));
      if (!ctx.checkTargets) return toolErrorResult('rename_symbol', '应用跨文件重命名必须通过工具执行管线进行授权；未做修改');
      await ctx.checkTargets([...files.values()].map((file) => file.abs));
      for (const file of files.values())
        if (sha1Of(await readFile(file.abs)) !== sha1Of(file.before))
          return toolErrorResult('rename_symbol', `${file.abs} 已被外部修改；未做修改，请重新规划`);
      const applied: Array<{ abs: string; before: string; after: string }> = [],
        states: Record<string, unknown> = {};
      try {
        for (const file of files.values()) {
          ctx.signal.throwIfAborted();
          if (sha1Of(await readFile(file.abs)) !== sha1Of(file.before)) throw new Error(`${file.abs} 已被外部修改`);
          const result = await commitWrite(file.abs, file.before, file.after, false, ctx.services);
          applied.push(file);
          states[file.abs] = result.fileState;
        }
      } catch (error) {
        const failed: string[] = [];
        for (const file of applied.reverse()) {
          try {
            if (sha1Of(await readFile(file.abs)) !== sha1Of(file.after)) {
              failed.push(file.abs);
              continue;
            }
            await commitWrite(file.abs, file.after, file.before, false, ctx.services);
          } catch {
            failed.push(file.abs);
          }
        }
        if (ctx.signal.aborted && !failed.length) throw error;
        return toolErrorResult(
          'rename_symbol',
          `${error instanceof Error ? error.message : String(error)}；${failed.length ? `以下文件未能回滚，请检查：${failed.join(', ')}` : '已回滚本次修改'}`,
        );
      }
      return textResult(JSON.stringify({ applied: true, files: plan }), { fileStates: states, replacements: locations.length });
    } finally {
      ls.service.dispose();
    }
  },
});
