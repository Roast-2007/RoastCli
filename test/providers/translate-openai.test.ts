/**
 * openai-compat translate 单测：wire chunk 序列 → StreamChunk 序列。
 */
import { describe, expect, it } from 'vitest';
import type { StreamChunk } from '../../src/core/types.js';
import { mapFinishReason, mapUsage, translate, type WireChunk } from '../../src/providers/openai-compat/translate.js';

async function* feed(chunks: WireChunk[]): AsyncGenerator<WireChunk> {
  for (const c of chunks) yield c;
}

async function collect(chunks: WireChunk[]): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of translate(feed(chunks))) out.push(c);
  return out;
}

describe('openai-compat mapUsage', () => {
  it('把 cache hit 从 prompt_tokens 中减出（disjoint）', () => {
    expect(
      mapUsage({ prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: 60 }),
    ).toEqual({ input: 60, output: 20, cacheRead: 40, cacheWrite: 60 });
  });

  it('缺省 cache 字段时全部为 0', () => {
    expect(mapUsage({ prompt_tokens: 10, completion_tokens: 5 })).toEqual({
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
});

describe('openai-compat mapFinishReason', () => {
  it('映射已知原因', () => {
    expect(mapFinishReason('stop')).toEqual({ reason: 'stop' });
    expect(mapFinishReason('tool_calls')).toEqual({ reason: 'tool-calls' });
    expect(mapFinishReason('length')).toEqual({ reason: 'max-tokens' });
  });

  it('未知原因映射为 error', () => {
    const mapped = mapFinishReason('content_filter');
    expect('error' in mapped).toBe(true);
  });
});

describe('openai-compat translate', () => {
  it('纯文本流', async () => {
    const chunks = await collect([
      { choices: [{ delta: { content: 'Hello' } }] },
      { choices: [{ delta: { content: ' world' } }] },
      {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      },
    ]);
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, block: 'text' },
      { type: 'text-delta', index: 0, text: 'Hello' },
      { type: 'text-delta', index: 0, text: ' world' },
      { type: 'block-end', index: 0 },
      { type: 'usage', usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 } },
      { type: 'finish', reason: 'stop' },
    ]);
  });

  it('reasoning + text 交错', async () => {
    const chunks = await collect([
      { choices: [{ delta: { reasoning_content: '想一下' } }] },
      { choices: [{ delta: { reasoning_content: '……' } }] },
      { choices: [{ delta: { content: '答案' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, block: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: '想一下' },
      { type: 'reasoning-delta', index: 0, text: '……' },
      { type: 'block-start', index: 1, block: 'text' },
      { type: 'text-delta', index: 1, text: '答案' },
      { type: 'block-end', index: 0 },
      { type: 'block-end', index: 1 },
      { type: 'finish', reason: 'stop' },
    ]);
  });

  it('tool_calls 增量 JSON', async () => {
    const chunks = await collect([
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } }] } },
        ],
      },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, block: 'tool-call', toolCall: { id: 'call_1', name: 'read_file' } },
      { type: 'tool-call-delta', index: 0, argsText: '{"pa' },
      { type: 'tool-call-delta', index: 0, argsText: 'th":"a.ts"}' },
      { type: 'block-end', index: 0 },
      { type: 'finish', reason: 'tool-calls' },
    ]);
  });

  it('length → max-tokens', async () => {
    const chunks = await collect([
      { choices: [{ delta: { content: '截断' } }] },
      { choices: [{ delta: {}, finish_reason: 'length' }] },
    ]);
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: 'max-tokens' });
  });

  it('usage-only 尾包也会被采用', async () => {
    const chunks = await collect([
      { choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 1, prompt_cache_hit_tokens: 90, prompt_cache_miss_tokens: 10 } },
    ]);
    expect(chunks.at(-2)).toEqual({
      type: 'usage',
      usage: { input: 10, output: 1, cacheRead: 90, cacheWrite: 10 },
    });
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: 'stop' });
  });

  it('缺失 finish_reason 时默认 stop，空流也恰好一个 finish', async () => {
    const chunks = await collect([]);
    expect(chunks).toEqual([{ type: 'finish', reason: 'stop' }]);
  });
});
