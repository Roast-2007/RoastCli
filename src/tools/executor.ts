/**
 * 工具执行管线：preExecute hooks → zod 校验 → validateInput → execute（含超时）→ postExecute hooks。
 * 全程不向外抛（除非调用方 abort），所有失败归一化为 ToolResult{isError:true}。
 */
import { asRoastError } from '../core/errors.js';
import {
  emptyHooks,
  toolErrorResult,
  type ToolContext,
  type ToolDefinition,
  type ToolExecutorHooks,
  type ToolResult,
} from './tool.js';

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')
  );
}

export async function executeTool(
  def: ToolDefinition,
  rawArgs: unknown,
  ctx: ToolContext,
  hooks: ToolExecutorHooks = emptyHooks(),
): Promise<ToolResult> {
  let args: unknown = rawArgs;
  try {
    // 1. preExecute hooks：deny → 直接返回；allow 可改写参数
    for (const hook of hooks.preExecute) {
      const decision = await hook(def, args, ctx);
      if (decision.action === 'deny') {
        return {
          content: [{ type: 'text', text: `工具 ${def.name} 执行被拒绝: ${decision.reason ?? '未给出理由'}` }],
          isError: true,
          metadata: { tool: def.name, denied: true },
        };
      }
      if (decision.args !== undefined) args = decision.args;
    }

    // 2. zod 校验：失败返回模型可读的字段错误列表（不抛）
    const parsed = def.parameters.safeParse(args);
    if (!parsed.success) {
      const details = parsed.error.issues
        .map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('\n');
      return {
        content: [{ type: 'text', text: `工具 ${def.name} 参数校验失败:\n${details}` }],
        isError: true,
        metadata: { tool: def.name },
      };
    }

    // 3. 工具自检
    const invalid = def.validateInput?.(parsed.data, ctx);
    if (invalid) return toolErrorResult(def.name, invalid);

    // 4. 执行：def.timeoutMs 与 ctx.signal 组合（AbortSignal.any，Node 24 原生）
    const signal = def.timeoutMs
      ? AbortSignal.any([ctx.signal, AbortSignal.timeout(def.timeoutMs)])
      : ctx.signal;
    let result = await def.execute(parsed.data, { ...ctx, signal });

    // 5. postExecute hooks：可替换结果
    for (const hook of hooks.postExecute) {
      result = await hook(def, parsed.data, result, ctx);
    }
    return result;
  } catch (err) {
    // 调用方 abort 向外抛；其余（含超时）归一化为 isError 结果
    if (ctx.signal.aborted) throw asRoastError(err);
    if (isAbortError(err) && def.timeoutMs) {
      return toolErrorResult(def.name, `工具 ${def.name} 执行超时（${def.timeoutMs}ms），已终止`);
    }
    return toolErrorResult(def.name, asRoastError(err));
  }
}
