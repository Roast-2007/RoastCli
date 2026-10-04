/**
 * 把 OpenAI 兼容 wire chunk 翻译成 provider 中立的 StreamChunk 序列。
 *
 * 要点：
 * - choices[].delta.content → text-delta；delta.reasoning_content → reasoning-delta
 * - delta.tool_calls[].function.arguments 是增量 JSON 文本 → tool-call-delta
 * - finish_reason: stop→stop, tool_calls→tool-calls, length→max-tokens，其余 → error finish
 * - usage 映射为 disjoint 计数：cacheRead（prompt_cache_hit_tokens）不计入 input，
 *   上游（如 DeepSeek）把 cache hit 计入 prompt_tokens 时在此减出来
 * - block-end / usage / finish 全部推迟到输入流结束（[DONE]）后发出，
 *   保证 finish 之后不再有任何 chunk
 */
import type { FinishReason, StreamChunk, TokenUsage } from '../../core/types.js';
import { RoastError } from '../../core/errors.js';

export interface WireToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

export interface WireChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: WireToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
  usage?: WireUsage | null;
}

export interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

/** disjoint 映射：cacheRead 从 prompt_tokens 中减出（上游若已 disjoint，hit 字段通常为 0/缺省，无害） */
export function mapUsage(usage: WireUsage): TokenUsage {
  const cacheRead = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    input: Math.max(0, (usage.prompt_tokens ?? 0) - cacheRead),
    output: usage.completion_tokens ?? 0,
    cacheRead,
    cacheWrite: usage.prompt_cache_miss_tokens ?? 0,
  };
}

export function mapFinishReason(reason: string): { reason: FinishReason } | { error: RoastError } {
  switch (reason) {
    case 'stop':
      return { reason: 'stop' };
    case 'tool_calls':
      return { reason: 'tool-calls' };
    case 'length':
      return { reason: 'max-tokens' };
    default:
      return { error: new RoastError('UNKNOWN', `模型以未识别的 finish_reason 结束: ${reason}`) };
  }
}

/**
 * 消费 wire chunk 序列，产出 StreamChunk。
 * 输入结束时恰好产出一个 finish chunk（error finish_reason 时 reason 为 'error'）。
 */
export async function* translate(chunks: AsyncIterable<WireChunk>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0;
  let textIndex: number | null = null;
  let reasoningIndex: number | null = null;
  const toolCallIndexes = new Map<number, number>(); // wire index → harness index
  const openOrder: number[] = [];
  let pendingFinish: FinishReason | null = null;
  let finishError: RoastError | null = null;
  let pendingUsage: TokenUsage | null = null;

  const openBlock = (): number => {
    const index = nextIndex++;
    openOrder.push(index);
    return index;
  };

  for await (const chunk of chunks) {
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta ?? {};

      const reasoning = delta.reasoning_content;
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        if (reasoningIndex === null) {
          reasoningIndex = openBlock();
          yield { type: 'block-start', index: reasoningIndex, block: 'reasoning' };
        }
        yield { type: 'reasoning-delta', index: reasoningIndex, text: reasoning };
      }

      const content = delta.content;
      if (typeof content === 'string' && content.length > 0) {
        if (textIndex === null) {
          textIndex = openBlock();
          yield { type: 'block-start', index: textIndex, block: 'text' };
        }
        yield { type: 'text-delta', index: textIndex, text: content };
      }

      for (const call of delta.tool_calls ?? []) {
        const wireIndex = call.index ?? 0;
        let index = toolCallIndexes.get(wireIndex);
        if (index === undefined) {
          index = openBlock();
          toolCallIndexes.set(wireIndex, index);
          yield {
            type: 'block-start',
            index,
            block: 'tool-call',
            toolCall: { id: call.id ?? '', name: call.function?.name ?? '' },
          };
        }
        const argsText = call.function?.arguments ?? '';
        if (argsText.length > 0) {
          yield { type: 'tool-call-delta', index, argsText };
        }
      }

      if (typeof choice.finish_reason === 'string') {
        const mapped = mapFinishReason(choice.finish_reason);
        if ('error' in mapped) finishError = mapped.error;
        else pendingFinish = mapped.reason;
      }
    }

    // usage 可能挂在 finish chunk 上，也可能是末尾的 usage-only chunk——取最新
    if (chunk.usage) pendingUsage = mapUsage(chunk.usage);
  }

  for (const index of openOrder) {
    yield { type: 'block-end', index };
  }
  if (pendingUsage) yield { type: 'usage', usage: pendingUsage };
  if (finishError) {
    yield { type: 'finish', reason: 'error', error: finishError };
  } else {
    yield { type: 'finish', reason: pendingFinish ?? 'stop' };
  }
}
