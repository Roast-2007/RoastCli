/**
 * 把 Anthropic /v1/messages 的 SSE 事件流翻译成 StreamChunk 序列。
 *
 * 事件映射：
 * - message_start → usage（input/cacheRead/cacheWrite，Anthropic 本身即 disjoint 计数）
 * - content_block_start (text/thinking/tool_use) → block-start(text/reasoning/tool-call)
 * - content_block_delta (text_delta/thinking_delta/input_json_delta) → 对应 delta
 * - content_block_stop → block-end
 * - message_delta → 记录 stop_reason（end_turn→stop, tool_use→tool-calls, max_tokens→max-tokens），
 *   usage.output_tokens 并入累计 usage 后发出 usage + finish
 * - message_stop → 若 finish 未发则补发 finish stop
 * - error 事件 → finish error
 *
 * 恰好产出一个 finish chunk。
 */
import type { FinishReason, StreamChunk, TokenUsage } from '../../core/types.js';
import { emptyUsage } from '../../core/types.js';
import { RoastError, isRetryableCode, type ErrorCode } from '../../core/errors.js';
import type { AnthropicSseEvent } from './sse.js';

export function mapStopReason(reason: string): { reason: FinishReason } | { error: RoastError } {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return { reason: 'stop' };
    case 'tool_use':
      return { reason: 'tool-calls' };
    case 'max_tokens':
      return { reason: 'max-tokens' };
    default:
      return { error: new RoastError('UNKNOWN', `模型以未识别的 stop_reason 结束: ${reason}`) };
  }
}

/** Anthropic 流内 error 事件的 type → 稳定 code */
export function mapErrorType(type: unknown): ErrorCode {
  switch (type) {
    case 'authentication_error':
    case 'permission_error':
      return 'AUTH';
    case 'rate_limit_error':
      return 'RATE_LIMIT';
    case 'billing_error':
      return 'QUOTA_EXCEEDED';
    case 'invalid_request_error':
    case 'not_found_error':
      return 'INVALID_REQUEST';
    default:
      return 'SERVER';
  }
}

export async function* translate(events: AsyncIterable<AnthropicSseEvent>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0;
  const wireToHarness = new Map<number, number>();
  let usage: TokenUsage | null = null;
  let pendingFinish: FinishReason | null = null;
  let finishError: RoastError | null = null;
  let finished = false;

  const emitFinish = (): StreamChunk => {
    finished = true;
    if (finishError) return { type: 'finish', reason: 'error', error: finishError };
    return { type: 'finish', reason: pendingFinish ?? 'stop' };
  };

  for await (const { event, data } of events) {
    const d = data as any;
    switch (event) {
      case 'message_start': {
        const u = d?.message?.usage;
        if (u) {
          usage = {
            input: u.input_tokens ?? 0,
            output: u.output_tokens ?? 0,
            cacheRead: u.cache_read_input_tokens ?? 0,
            cacheWrite: u.cache_creation_input_tokens ?? 0,
          };
          yield { type: 'usage', usage };
        }
        break;
      }
      case 'content_block_start': {
        const wireIndex = typeof d?.index === 'number' ? d.index : 0;
        const index = nextIndex++;
        wireToHarness.set(wireIndex, index);
        const block = d?.content_block ?? {};
        if (block.type === 'thinking') {
          yield { type: 'block-start', index, block: 'reasoning' };
        } else if (block.type === 'redacted_thinking') {
          yield { type: 'block-start', index, block: 'reasoning', redactedData: String(block.data ?? '') };
        } else if (block.type === 'tool_use') {
          yield {
            type: 'block-start',
            index,
            block: 'tool-call',
            toolCall: { id: block.id ?? '', name: block.name ?? '' },
          };
        } else {
          // text 及未知类型按 text 处理
          yield { type: 'block-start', index, block: 'text' };
        }
        break;
      }
      case 'content_block_delta': {
        const wireIndex = typeof d?.index === 'number' ? d.index : 0;
        const index = wireToHarness.get(wireIndex);
        if (index === undefined) break;
        const delta = d?.delta ?? {};
        if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
          yield { type: 'text-delta', index, text: delta.text };
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking.length > 0) {
          yield { type: 'reasoning-delta', index, text: delta.thinking };
        } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string' && delta.signature.length > 0) {
          yield { type: 'reasoning-signature', index, signature: delta.signature };
        } else if (
          delta.type === 'input_json_delta' &&
          typeof delta.partial_json === 'string' &&
          delta.partial_json.length > 0
        ) {
          yield { type: 'tool-call-delta', index, argsText: delta.partial_json };
        }
        break;
      }
      case 'content_block_stop': {
        const wireIndex = typeof d?.index === 'number' ? d.index : 0;
        const index = wireToHarness.get(wireIndex);
        if (index !== undefined) {
          wireToHarness.delete(wireIndex);
          yield { type: 'block-end', index };
        }
        break;
      }
      case 'message_delta': {
        const stopReason = d?.delta?.stop_reason;
        const outputTokens = d?.usage?.output_tokens;
        if (typeof outputTokens === 'number') {
          usage = { ...(usage ?? emptyUsage()), output: outputTokens };
          yield { type: 'usage', usage };
        }
        if (typeof stopReason === 'string') {
          const mapped = mapStopReason(stopReason);
          if ('error' in mapped) finishError = mapped.error;
          else pendingFinish = mapped.reason;
          yield emitFinish();
          return;
        }
        break;
      }
      case 'message_stop': {
        if (!finished) yield emitFinish();
        return;
      }
      case 'error': {
        const e = d?.error ?? {};
        const code = mapErrorType(e?.type);
        finished = true;
        yield {
          type: 'finish',
          reason: 'error',
          error: new RoastError(code, `Anthropic 流错误 (${String(e?.type ?? 'unknown')}): ${String(e?.message ?? '')}`, {
            retryable: isRetryableCode(code),
          }),
        };
        return;
      }
      default:
        break; // ping 等事件忽略
    }
  }

  // EOF 兜底：流在 message_delta/message_stop 之前结束
  if (!finished) {
    if (finishError || pendingFinish) {
      yield emitFinish();
    } else {
      yield {
        type: 'finish',
        reason: 'error',
        error: new RoastError('SERVER', 'SSE 流在 message_stop 之前结束（响应被截断）', { retryable: true }),
      };
    }
  }
}
