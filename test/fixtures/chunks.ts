/**
 * StreamChunk 构造器：测试里拼装 provider 回放脚本用。
 */
import type { StreamChunk, TokenUsage } from '../../src/core/types.js';
import { RoastError, type ErrorCode } from '../../src/core/errors.js';

export function usageOf(input: number, output: number, cacheRead = 0, cacheWrite = 0): TokenUsage {
  return { input, output, cacheRead, cacheWrite };
}

/** 纯文本回答 */
export function textScript(text: string, usage: TokenUsage = usageOf(10, 5)): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, block: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0 },
    { type: 'usage', usage },
    { type: 'finish', reason: 'stop' },
  ];
}

export interface ScriptedCall {
  id: string;
  name: string;
  args: unknown;
}

/** 一个或多个工具调用 */
export function toolCallsScript(calls: ScriptedCall[], usage: TokenUsage = usageOf(20, 8)): StreamChunk[] {
  const chunks: StreamChunk[] = [];
  calls.forEach((c, index) => {
    chunks.push({ type: 'block-start', index, block: 'tool-call', toolCall: { id: c.id, name: c.name } });
    chunks.push({ type: 'tool-call-delta', index, argsText: JSON.stringify(c.args) });
    chunks.push({ type: 'block-end', index });
  });
  chunks.push({ type: 'usage', usage });
  chunks.push({ type: 'finish', reason: 'tool-calls' });
  return chunks;
}

export function toolCallScript(id: string, name: string, args: unknown, usage?: TokenUsage): StreamChunk[] {
  return toolCallsScript([{ id, name, args }], usage);
}

/** 先 reasoning 再 text */
export function reasoningTextScript(reasoning: string, text: string, signature?: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, block: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: reasoning },
    ...(signature ? [{ type: 'reasoning-signature', index: 0, signature } as StreamChunk] : []),
    { type: 'block-end', index: 0 },
    { type: 'block-start', index: 1, block: 'text' },
    { type: 'text-delta', index: 1, text },
    { type: 'block-end', index: 1 },
    { type: 'usage', usage: usageOf(10, 5) },
    { type: 'finish', reason: 'stop' },
  ];
}

/** 流以错误终结 */
export function errorScript(code: ErrorCode, message = 'boom', retryable = false): StreamChunk[] {
  return [{ type: 'finish', reason: 'error', error: new RoastError(code, message, { retryable }) }];
}
