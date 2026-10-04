import { describe, expect, it } from 'vitest';
import type { Message } from '../../src/core/types.js';
import { buildMessages } from '../../src/providers/anthropic/request.js';

describe('anthropic buildMessages：thinking 回放', () => {
  it('带 signature 的 reasoning 回放为 thinking block，位于 assistant 内容首位', () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'hmm', signature: 'sig-1' },
          { type: 'tool-call', id: 't1', name: 'read', args: {} },
        ],
      },
    ];
    const { out } = buildMessages(msgs);
    expect(out[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hmm', signature: 'sig-1' },
        { type: 'tool_use', id: 't1', name: 'read', input: {} },
      ],
    });
  });

  it('redacted thinking 回放为 redacted_thinking', () => {
    const msgs: Message[] = [
      { role: 'assistant', content: [{ type: 'reasoning', text: '', redactedData: 'ENC' }, { type: 'text', text: 'a' }] },
    ];
    const { out } = buildMessages(msgs);
    expect(out[0]).toEqual({
      role: 'assistant',
      content: [
        { type: 'redacted_thinking', data: 'ENC' },
        { type: 'text', text: 'a' },
      ],
    });
  });

  it('无 signature 的 reasoning（如来自其他 provider）被丢弃', () => {
    const msgs: Message[] = [{ role: 'assistant', content: [{ type: 'reasoning', text: 'x' }, { type: 'text', text: 'a' }] }];
    const { out } = buildMessages(msgs);
    expect(out[0]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'a' }] });
  });
});

describe('anthropic buildRequest：prompt caching 断点', () => {
  it('system、最后一个工具、最后一条消息的最后一个 block 带 cache_control', async () => {
    const { buildRequest } = await import('../../src/providers/anthropic/request.js');
    const req = buildRequest(
      {
        model: 'c',
        system: 'SYS',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'a' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
          { role: 'user', content: [{ type: 'text', text: 'c1' }, { type: 'text', text: 'c2' }] },
        ],
        tools: [
          { name: 't1', description: 'd', parameters: {} },
          { name: 't2', description: 'd', parameters: {} },
        ],
      },
      { promptCaching: true },
    ) as Record<string, any>;
    expect(req['system']).toEqual([{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }]);
    expect(req['tools'][0].cache_control).toBeUndefined();
    expect(req['tools'][1].cache_control).toEqual({ type: 'ephemeral' });
    const last = req['messages'].at(-1);
    expect(last.content[0].cache_control).toBeUndefined();
    expect(last.content[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('关闭时保持字符串 system、无断点', async () => {
    const { buildRequest } = await import('../../src/providers/anthropic/request.js');
    const req = buildRequest({ model: 'c', system: 'SYS', messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }] }] }, { promptCaching: false });
    expect(req['system']).toBe('SYS');
    expect(JSON.stringify(req)).not.toContain('cache_control');
  });
});

describe('anthropic buildRequest：extended thinking', () => {
  it('sends effort independently of thinking while preserving explicit legacy budgets', async () => {
    const { buildRequest } = await import('../../src/providers/anthropic/request.js');
    const base = { model: 'claude-x', messages: [], temperature: 0.3 };
    expect(buildRequest(base, { reasoningEffort: 'max' })).toMatchObject({ output_config: { effort: 'max' } });
    expect(buildRequest(base, { reasoningEffort: 'low' })).not.toHaveProperty('thinking');
    expect(buildRequest(base)).not.toHaveProperty('output_config');
    expect(buildRequest(base, { reasoningEffort: 'high', thinkingBudget: 8000 })).toMatchObject({ output_config: { effort: 'high' }, thinking: { type: 'enabled', budget_tokens: 8000 } });
  });
  it('sends thinking with budget, keeps max_tokens above it and drops temperature', async () => {
    const { buildRequest } = await import('../../src/providers/anthropic/request.js');
    const base = { model: 'claude-x', messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }], temperature: 0.3, maxTokens: 2000 };
    const req = buildRequest(base, { thinkingBudget: 8000 });
    expect(req['thinking']).toEqual({ type: 'enabled', budget_tokens: 8000 });
    expect(req['max_tokens']).toBe(12096);
    expect(req['temperature']).toBeUndefined();
    const plain = buildRequest(base);
    expect(plain['thinking']).toBeUndefined();
    expect(plain['temperature']).toBe(0.3);
    expect(buildRequest({ ...base, maxTokens: 32000 }, { thinkingBudget: 8000 })['max_tokens']).toBe(32000);
  });
});
