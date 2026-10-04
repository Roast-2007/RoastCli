/**
 * 工具调用调度（借鉴 deepseek-harness 的 executeToolCalls 与 ccsource 的 runTools）：
 * - 按模型给出的顺序扫描；连续的 isConcurrencySafe 调用并发执行，写工具独占屏障
 * - 结果严格按模型顺序提交（即使执行并发）
 * - abort 时为执行中/尚未开始的调用都补合成 error 结果（runOne 绝不向外抛），保证消息配对完整
 */
import type { ToolCallBlock, ToolResultBlock } from '../core/types.js';
import { RoastError } from '../core/errors.js';
import { executeTool } from '../tools/executor.js';
import type { ToolContext, ToolExecutorHooks, ToolRegistry, ToolResult } from '../tools/index.js';
import { emptyHooks } from '../tools/index.js';

export interface ToolCallOutcome {
  callId: string;
  name: string;
  result: ToolResult;
  durationMs: number;
}

export type ToolCallEvent =
  | { type: 'progress'; callId: string; name: string; text: string }
  | { type: 'start'; callId: string; name: string; args: unknown }
  | { type: 'end'; outcome: ToolCallOutcome };

/** 中断时的合成结果：inFlight=true 表示执行到一半被中断（副作用可能已部分发生） */
function syntheticAbortResult(name: string, inFlight: boolean): ToolResult {
  const text = inFlight
    ? `工具 ${name} 执行中被用户中断，结果未知（可能已产生部分副作用）`
    : `工具 ${name} 未执行：调用被用户中断`;
  return {
    content: [{ type: 'text', text }],
    isError: true,
    metadata: { tool: name, aborted: true, inFlight },
  };
}

export async function executeToolCalls(
  calls: ToolCallBlock[],
  registry: ToolRegistry,
  ctx: ToolContext,
  onEvent: (e: ToolCallEvent) => void = () => {},
  hooks: ToolExecutorHooks = emptyHooks(),
): Promise<ToolCallOutcome[]> {
  const outcomes: (ToolCallOutcome | null)[] = new Array(calls.length).fill(null);

  const callCtx = (call: ToolCallBlock): ToolContext => ({
    ...ctx,
    callId: call.id,
    progress: (p) => onEvent({ type: 'progress', callId: call.id, name: call.name, text: p.text }),
  });

  const runOne = async (i: number): Promise<void> => {
    const call = calls[i]!;
    onEvent({ type: 'start', callId: call.id, name: call.name, args: call.args });
    const started = Date.now();
    let result: ToolResult;
    const def = safeGet(registry, call.name);
    try {
      // UNKNOWN_TOOL 等查找失败按普通错误处理，不会被误标为"中断"
      result = def
        ? await executeTool(def, call.args, callCtx(call), hooks)
        : { content: [{ type: 'text', text: `未知或不可用的工具: ${call.name}` }], isError: true, metadata: { tool: call.name } };
    } catch (err) {
      if ((err instanceof RoastError && err.code === 'ABORTED') || ctx.signal.aborted) {
        // 执行中被中断：补合成结果（绝不向外抛，保证 tool-call/result 配对完整）
        result = syntheticAbortResult(call.name, true);
      } else {
        // UNKNOWN_TOOL 等：作为模型可见的错误结果返回，不中断循环
        result = {
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
          isError: true,
          metadata: { tool: call.name },
        };
      }
    }
    const outcome = { callId: call.id, name: call.name, result, durationMs: Date.now() - started };
    outcomes[i] = outcome;
    onEvent({ type: 'end', outcome });
  };

  // 按序扫描：连续并发安全段批量并发，其余独占执行
  let i = 0;
  while (i < calls.length) {
    if (ctx.signal.aborted) break;
    const def = safeGet(registry, calls[i]!.name);
    if (def?.isConcurrencySafe) {
      const batch: number[] = [];
      while (i < calls.length && safeGet(registry, calls[i]!.name)?.isConcurrencySafe) {
        batch.push(i++);
      }
      await Promise.all(batch.map(runOne));
    } else {
      await runOne(i++);
    }
  }

  // abort：为未执行的调用补合成结果（按模型顺序）
  if (ctx.signal.aborted) {
    for (let j = 0; j < calls.length; j++) {
      if (!outcomes[j]) {
        const call = calls[j]!;
        outcomes[j] = {
          callId: call.id,
          name: call.name,
          result: syntheticAbortResult(call.name, false),
          durationMs: 0,
        };
      }
    }
  }

  return outcomes.map((o) => o!);
}

function safeGet(registry: ToolRegistry, name: string) {
  try {
    return registry.get(name);
  } catch {
    return undefined;
  }
}

/** 把调度结果组装为回给模型的 user 消息（tool-result blocks，按模型顺序；isError 仅在 true 时出现，与日志投影一致） */
export function toolResultsMessage(outcomes: ToolCallOutcome[]): { role: 'user'; content: ToolResultBlock[] } {
  return {
    role: 'user',
    content: outcomes.map((o) => ({
      type: 'tool-result',
      toolCallId: o.callId,
      name: o.name,
      content: o.result.content,
      ...(o.result.isError ? { isError: true } : {}),
    })),
  };
}
