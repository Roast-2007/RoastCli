/**
 * anthropic translate 单测：SSE 事件序列 → StreamChunk 序列。
 */
import { describe, expect, it } from 'vitest';
import type { StreamChunk } from '../../src/core/types.js';
import type { AnthropicSseEvent } from '../../src/providers/anthropic/sse.js';
import { mapStopReason, translate } from '../../src/providers/anthropic/translate.js';

async function* feed(events: AnthropicSseEvent[]): AsyncGenerator<AnthropicSseEvent> {
  for (const e of events) yield e;
}

async function collect(events: AnthropicSseEvent[]): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of translate(feed(events))) out.push(c);
  return out;
}

const ev = (event: string, data: unknown): AnthropicSseEvent => ({ event, data });

describe('anthropic mapStopReason', () => {
  it('映射已知原因', () => {
    expect(mapStopReason('end_turn')).toEqual({ reason: 'stop' });
    expect(mapStopReason('stop_sequence')).toEqual({ reason: 'stop' });
    expect(mapStopReason('tool_use')).toEqual({ reason: 'tool-calls' });
    expect(mapStopReason('max_tokens')).toEqual({ reason: 'max-tokens' });
  });
});

describe('anthropic translate', () => {
  it('文本流：message_start → block → delta → stop → message_delta(end_turn)', async () => {
    const chunks = await collect([
      ev('message_start', {
        type: 'message_start',
        message: { usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 } },
      }),
      ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } }),
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '，世界' } }),
      ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }),
    ]);
    expect(chunks).toEqual([
      { type: 'usage', usage: { input: 10, output: 1, cacheRead: 4, cacheWrite: 2 } },
      { type: 'block-start', index: 0, block: 'text' },
      { type: 'text-delta', index: 0, text: '你好' },
      { type: 'text-delta', index: 0, text: '，世界' },
      { type: 'block-end', index: 0 },
      { type: 'usage', usage: { input: 10, output: 3, cacheRead: 4, cacheWrite: 2 } },
      { type: 'finish', reason: 'stop' },
    ]);
  });

  it('tool_use：input_json_delta.partial_json → tool-call-delta；stop_reason tool_use → tool-calls', async () => {
    const chunks = await collect([
      ev('message_start', { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } }),
      ev('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file' },
      }),
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } }),
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"a.ts"}' } }),
      ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } }),
      ev('message_stop', { type: 'message_stop' }),
    ]);
    expect(chunks).toEqual([
      { type: 'usage', usage: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { type: 'block-start', index: 0, block: 'tool-call', toolCall: { id: 'toolu_1', name: 'read_file' } },
      { type: 'tool-call-delta', index: 0, argsText: '{"path":' },
      { type: 'tool-call-delta', index: 0, argsText: '"a.ts"}' },
      { type: 'block-end', index: 0 },
      { type: 'usage', usage: { input: 5, output: 12, cacheRead: 0, cacheWrite: 0 } },
      { type: 'finish', reason: 'tool-calls' },
    ]);
  });

  it('message_stop 补发 finish（message_delta 没有 stop_reason 时）', async () => {
    const chunks = await collect([
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'x' } }),
      ev('content_block_stop', { index: 0 }),
      ev('message_stop', { type: 'message_stop' }),
    ]);
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: 'stop' });
  });

  it('thinking_delta → reasoning-delta', async () => {
    const chunks = await collect([
      ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
      ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: '嗯' } }),
      ev('content_block_stop', { index: 0 }),
      ev('message_delta', { delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 1 } }),
    ]);
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, block: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: '嗯' },
      { type: 'block-end', index: 0 },
      { type: 'usage', usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 } },
      { type: 'finish', reason: 'max-tokens' },
    ]);
  });

  it('error 事件 → finish error', async () => {
    const chunks = await collect([
      ev('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }),
    ]);
    expect(chunks).toHaveLength(1);
    const finish = chunks[0]!;
    expect(finish.type).toBe('finish');
    if (finish.type === 'finish') {
      expect(finish.reason).toBe('error');
      expect(finish.error?.code).toBe('SERVER');
      expect(finish.error?.retryable).toBe(true);
    }
  });

  it('流截断（无 message_stop/message_delta）→ finish error SERVER', async () => {
    const chunks = await collect([
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    ]);
    const finish = chunks.at(-1)!;
    expect(finish.type).toBe('finish');
    if (finish.type === 'finish') {
      expect(finish.reason).toBe('error');
      expect(finish.error?.code).toBe('SERVER');
    }
  });
});

describe('anthropic translate：thinking 签名与 redacted', () => {
  it('signature_delta → reasoning-signature chunk', async () => {
    const chunks = await collect([
      ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '想' } }),
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG' } }),
      ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
    ]);
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, block: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: '想' },
      { type: 'reasoning-signature', index: 0, signature: 'SIG' },
      { type: 'block-end', index: 0 },
      { type: 'finish', reason: 'stop' },
    ]);
  });

  it('redacted_thinking → 带 redactedData 的 reasoning block-start', async () => {
    const chunks = await collect([
      ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'ENC' } }),
      ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
    ]);
    expect(chunks.slice(0, 2)).toEqual([
      { type: 'block-start', index: 0, block: 'reasoning', redactedData: 'ENC' },
      { type: 'block-end', index: 0 },
    ]);
  });
});
