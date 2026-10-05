/**
 * Anthropic /v1/messages 请求体构建（纯函数）。
 *
 * - system 走顶层字段（GenerateOptions.system + 消息里 role:'system' 的文本折叠进来）
 * - messages 只含 user/assistant；text→text，tool-call→tool_use，tool-result→user 消息里的 tool_result
 * - reasoning 回放：带 signature → thinking；带 redactedData → redacted_thinking；
 *   都没有（如来自其他 provider 的推理）→ 丢弃（无法通过签名校验）
 * - tools → { name, description, input_schema }；max_tokens 必填
 * - thinkingBudget（模型配置）→ thinking: { type: enabled, budget_tokens }，max_tokens 自动加余量
 */
import type { ContentBlock, GenerateOptions, Message } from '../../core/types.js';
import { DEFAULT_MAX_TOKENS } from './config.js';
import type { ReasoningEffort } from '../../core/config.js';

function blocksToText(blocks: ContentBlock[]): string {
  return blocks
    .map((b) => (b.type === 'text' ? b.text : ''))
    .filter((s) => s.length > 0)
    .join('\n');
}

/** tool-call 参数；解析失败的 { __raw } 尽力重解析，失败则空对象 */
function normalizeArgs(args: unknown): unknown {
  if (args !== null && typeof args === 'object' && '__raw' in args) {
    try {
      return JSON.parse(String((args as { __raw: unknown }).__raw));
    } catch {
      return {};
    }
  }
  return args ?? {};
}

function wireBlock(b: ContentBlock, role: Message['role']): unknown | null {
  switch (b.type) {
    case 'text':
      return { type: 'text', text: b.text };
    case 'tool-call':
      return { type: 'tool_use', id: b.id, name: b.name, input: normalizeArgs(b.args) };
    case 'tool-result':
      // tool_result 只能出现在 user 消息里
      if (role !== 'user') return null;
      return { type: 'tool_result', tool_use_id: b.toolCallId, content: b.content.some((c) => c.type === 'image') ? b.content.filter((c) => c.type === 'text' || c.type === 'image').map((c) => wireBlock(c, 'user')) : blocksToText(b.content), is_error: b.isError ?? false };
    case 'reasoning':
      if (role !== 'assistant') return null;
      if (b.redactedData !== undefined) return { type: 'redacted_thinking', data: b.redactedData };
      if (b.signature) return { type: 'thinking', thinking: b.text, signature: b.signature };
      return null;
    case 'image':
      return { type: 'image', source: { type: 'base64', media_type: b.mediaType, data: b.data } };
  }
}

export function buildMessages(messages: Message[]): { systemText: string | undefined; out: unknown[] } {
  const systemParts: string[] = [];
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      const text = blocksToText(m.content);
      if (text) systemParts.push(text);
      continue;
    }
    const blocks = m.content.map((b) => wireBlock(b, m.role)).filter((b) => b !== null);
    if (blocks.length > 0) out.push({ role: m.role, content: blocks });
  }
  return { systemText: systemParts.length > 0 ? systemParts.join('\n\n') : undefined, out };
}

export interface AnthropicRequestOptions {
  /** 打 cache_control 断点（system、最后一个工具、最后一条消息的最后一个 block） */
  promptCaching?: boolean;
  /** extended thinking 预算（tokens）；开启时不发送 temperature（API 不允许二者同时设置） */
  thinkingBudget?: number;
  reasoningEffort?: ReasoningEffort;
}

/** 开启 thinking 时，max_tokens 至少比预算多出这么多（留给正文与工具调用） */
const THINKING_HEADROOM = 4096;

const EPHEMERAL = { type: 'ephemeral' } as const;

/** 给最后一条消息的最后一个 block 打缓存断点（不修改入参） */
function markLastMessage(messages: unknown[], boundary?: number): unknown[] {
  const indices = new Set([messages.length - 1, ...(boundary && boundary < messages.length ? [boundary - 1] : [])]);
  return messages.map((value, index) => {
    const msg = value as { role: string; content: Record<string, unknown>[] };
    if (!indices.has(index)) return value;
    let last = msg.content.length - 1;
    while (last >= 0 && ['thinking', 'redacted_thinking'].includes(String(msg.content[last]!['type']))) last--;
    return { ...msg, content: msg.content.map((b, i) => i === last ? { ...b, cache_control: EPHEMERAL } : b) };
  });
}

export function buildRequest(options: GenerateOptions, opts: AnthropicRequestOptions = {}): Record<string, unknown> {
  const { systemText, out } = buildMessages(options.messages);
  const system = [options.system, systemText].filter((s) => s && s.length > 0).join('\n\n');
  const cache = opts.promptCaching === true;
  const budget = opts.thinkingBudget;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const request: Record<string, unknown> = {
    model: options.model,
    max_tokens: budget ? Math.max(maxTokens, budget + THINKING_HEADROOM) : maxTokens,
    messages: cache ? markLastMessage(out, options.cacheBoundary) : out,
    stream: true,
  };
  if (system) request['system'] = cache ? [{ type: 'text', text: system, cache_control: EPHEMERAL }] : system;
  if (budget) request['thinking'] = { type: 'enabled', budget_tokens: budget };
  else if (options.temperature !== undefined) request['temperature'] = options.temperature;
  if (opts.reasoningEffort !== undefined) request['output_config'] = { effort: opts.reasoningEffort };
  if (options.tools && options.tools.length > 0) {
    const last = options.tools.length - 1;
    request['tools'] = options.tools.map((t, i) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
      ...(cache && i === last ? { cache_control: EPHEMERAL } : {}),
    }));
  }
  return request;
}
