/**
 * openai-compat 请求体构建（纯函数）：Message[] → chat/completions wire 格式。
 *
 * reasoning 回传策略（ReasoningReplay）：
 * - drop（默认）：历史 reasoning 不回传，省上下文
 * - field：仅"当前 turn"（最后一条含文本的 user 消息之后）的 assistant 以 reasoning_content 字段回传
 *   —— DeepSeek 思考模式在同一 turn 的工具循环里需要它；跨 turn 的旧推理丢弃
 * - inline：拼进 content（旧行为，兼容用）
 */
import type { ContentBlock, GenerateOptions, Message } from '../../core/types.js';
import type { ReasoningEffort } from '../../core/config.js';

export type ReasoningReplay = 'drop' | 'field' | 'inline';
/** 输出上限字段名：OpenAI o 系列 / gpt-5 只接受 max_completion_tokens */
export type MaxTokensField = 'max_tokens' | 'max_completion_tokens';

export function defaultMaxTokensField(model: string): MaxTokensField {
  return /^(o\d|gpt-5)/i.test(model) ? 'max_completion_tokens' : 'max_tokens';
}

export interface WireMessage {
  role: string;
  content: string | null;
  reasoning_content?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
}

/** tool-result 等嵌套 content 拍平为纯文本（嵌套里的 reasoning 不回传） */
function blocksToText(blocks: ContentBlock[]): string {
  return blocks
    .map((b) => (b.type === 'text' ? b.text : ''))
    .filter((s) => s.length > 0)
    .join('\n');
}

/** 序列化 tool-call 参数；解析失败的 { __raw } 原样回传 */
function stringifyArgs(args: unknown): string {
  if (args !== null && typeof args === 'object' && '__raw' in args) {
    return String((args as { __raw: unknown }).__raw);
  }
  return JSON.stringify(args ?? {});
}

/** 最后一条含文本的 user 消息下标（当前 turn 的起点）；没有则 -1 */
function currentTurnStart(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && m.content.some((b) => b.type === 'text')) return i;
  }
  return -1;
}

/** 返回 null 表示该消息不应发送（既无内容也无工具调用，OpenAI 会拒绝 content:null） */
function assistantMessage(m: Message, replay: ReasoningReplay, inCurrentTurn: boolean): WireMessage | null {
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: NonNullable<WireMessage['tool_calls']> = [];
  for (const b of m.content) {
    if (b.type === 'text') textParts.push(b.text);
    else if (b.type === 'reasoning' && b.text) reasoningParts.push(b.text);
    else if (b.type === 'tool-call') {
      toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: stringifyArgs(b.args) } });
    }
  }
  const contentParts = replay === 'inline' ? [...reasoningParts, ...textParts] : textParts;
  const msg: WireMessage = { role: 'assistant', content: contentParts.length > 0 ? contentParts.join('\n') : null };
  if (replay === 'field' && inCurrentTurn && reasoningParts.length > 0) msg.reasoning_content = reasoningParts.join('\n');
  if (toolCalls.length > 0) msg.tool_calls = toolCalls;
  if (msg.content === null && toolCalls.length === 0) {
    if (msg.reasoning_content === undefined) return null;
    msg.content = '';
  }
  return msg;
}

/** user / system：text 拼成 string content；tool-result 拆成 role:'tool' 消息 */
function nonAssistantMessages(m: Message): WireMessage[] {
  const out: WireMessage[] = [];
  let textParts: string[] = [];
  const flushText = () => {
    if (textParts.length > 0) {
      out.push({ role: m.role, content: textParts.join('\n') });
      textParts = [];
    }
  };
  for (const b of m.content) {
    if (b.type === 'tool-result') {
      flushText();
      out.push({ role: 'tool', tool_call_id: b.toolCallId, content: blocksToText(b.content) });
    } else if (b.type === 'text') {
      textParts.push(b.text);
    }
  }
  flushText();
  return out;
}

export function buildMessages(messages: Message[], replay: ReasoningReplay = 'drop'): WireMessage[] {
  const turnStart = currentTurnStart(messages);
  return messages.flatMap((m, i) => {
    if (m.role !== 'assistant') return nonAssistantMessages(m);
    const msg = assistantMessage(m, replay, i > turnStart);
    return msg ? [msg] : [];
  });
}

export function buildRequest(
  options: GenerateOptions,
  replay: ReasoningReplay = 'drop',
  maxTokensField: MaxTokensField = defaultMaxTokensField(options.model),
  reasoningEffort?: ReasoningEffort,
): Record<string, unknown> {
  const messages = buildMessages(options.messages, replay);
  if (options.system) messages.unshift({ role: 'system', content: options.system });
  const request: Record<string, unknown> = {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (options.maxTokens !== undefined) request[maxTokensField] = options.maxTokens;
  if (options.temperature !== undefined) request['temperature'] = options.temperature;
  if (reasoningEffort !== undefined) request['reasoning_effort'] = reasoningEffort;
  if (options.tools && options.tools.length > 0) {
    request['tools'] = options.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  return request;
}
