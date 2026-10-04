import { describe, expect, it } from 'vitest';
import type { Message } from '../../src/core/types.js';
import { buildMessages, buildRequest } from '../../src/providers/openai-compat/request.js';

const history: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'q1' }] },
  {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'old thinking' },
      { type: 'text', text: 'a1' },
    ],
  },
  { role: 'user', content: [{ type: 'text', text: 'q2' }] },
  {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'current thinking' },
      { type: 'tool-call', id: 'c1', name: 'read', args: { path: 'x' } },
    ],
  },
  { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', name: 'read', content: [{ type: 'text', text: 'X' }] }] },
];

describe('openai-compat buildMessages：reasoning 回传策略', () => {
  it('sends an explicit reasoning effort and omits it when automatic', () => {
    const options = { model: 'kimi-for-coding', messages: [] };
    expect(buildRequest(options, 'drop', 'max_tokens', 'max')).toHaveProperty('reasoning_effort', 'max');
    expect(buildRequest(options, 'drop', 'max_tokens', 'none')).toHaveProperty('reasoning_effort', 'none');
    expect(buildRequest(options)).not.toHaveProperty('reasoning_effort');
  });
  it('默认 drop：reasoning 不进入 content，也不带 reasoning_content', () => {
    const out = buildMessages(history, 'drop');
    const assistants = out.filter((m) => m.role === 'assistant');
    expect(assistants[0]).toEqual({ role: 'assistant', content: 'a1' });
    expect(assistants[1]).toMatchObject({ role: 'assistant', content: null });
    expect(JSON.stringify(out)).not.toContain('thinking');
  });

  it('field：仅当前 turn（最后一条用户文本之后）的 assistant 带 reasoning_content', () => {
    const out = buildMessages(history, 'field');
    const assistants = out.filter((m) => m.role === 'assistant');
    expect(assistants[0]).not.toHaveProperty('reasoning_content');
    expect(assistants[1]).toMatchObject({ reasoning_content: 'current thinking', content: null });
  });

  it('inline：沿用旧行为，reasoning 拼进 content', () => {
    const out = buildMessages(history, 'inline');
    expect(out.find((m) => m.role === 'assistant')?.content).toBe('old thinking\na1');
  });

  it('tool-result 拆为 role:tool 消息', () => {
    const out = buildMessages(history, 'drop');
    expect(out.at(-1)).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'X' });
  });
});

describe('openai-compat buildRequest', () => {
  it('携带 max_tokens 与 system', () => {
    const req = buildRequest({ model: 'm', system: 'sys', messages: [history[0]!], maxTokens: 123 }, 'drop');
    expect(req['max_tokens']).toBe(123);
    expect((req['messages'] as { role: string }[])[0]).toEqual({ role: 'system', content: 'sys' });
  });
});

describe('openai-compat buildMessages：只有 reasoning 的 assistant', () => {
  const onlyReasoning: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'q' }] },
    { role: 'assistant', content: [{ type: 'reasoning', text: '想到一半被截断' }] },
    { role: 'user', content: [{ type: 'text', text: 'q2' }] },
  ];

  it('drop：跳过该消息，不发送 content:null 且无 tool_calls 的 assistant', () => {
    const out = buildMessages(onlyReasoning, 'drop');
    expect(out.some((m) => m.role === 'assistant')).toBe(false);
  });

  it('field：当前 turn 内保留，content 为空串而非 null', () => {
    const cur: Message[] = onlyReasoning.slice(0, 2);
    const out = buildMessages(cur, 'field');
    expect(out[1]).toEqual({ role: 'assistant', content: '', reasoning_content: '想到一半被截断' });
  });
});

describe('openai-compat buildRequest：max_tokens 字段名', () => {
  it('o 系列 / gpt-5 使用 max_completion_tokens', () => {
    const req = buildRequest({ model: 'gpt-5-mini', messages: [], maxTokens: 10 }, 'drop');
    expect(req['max_completion_tokens']).toBe(10);
    expect(req).not.toHaveProperty('max_tokens');
    expect(buildRequest({ model: 'o3', messages: [], maxTokens: 10 }, 'drop')['max_completion_tokens']).toBe(10);
  });
  it('显式配置优先', () => {
    const req = buildRequest({ model: 'deepseek-chat', messages: [], maxTokens: 10 }, 'drop', 'max_completion_tokens');
    expect(req['max_completion_tokens']).toBe(10);
  });
});
