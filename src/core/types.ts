/**
 * 统一消息 / 流 / 工具词汇。
 * 所有 provider 适配器、agent loop、工具层、会话日志共用这一套类型。
 * 设计参考 deepseek-harness 的 StreamChunk 词汇与 ccsource 的 Message 形态。
 */

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ReasoningBlock {
  type: 'reasoning';
  text: string;
  /** Anthropic thinking 重放所需（可选；openai-compat 不产生） */
  signature?: string;
  /** Anthropic redacted_thinking 的加密数据（text 为空；原样回放） */
  redactedData?: string;
}

/** base64 编码图片（未来多模态用，本期工具层不产出） */
export interface ImageBlock {
  type: 'image';
  mediaType: string;
  data: string;
}

export interface ToolCallBlock {
  type: 'tool-call';
  id: string;
  name: string;
  /** 已解析的 JSON 参数；解析失败时为 { __raw: string } */
  args: unknown;
}

export interface ToolResultBlock {
  type: 'tool-result';
  toolCallId: string;
  name: string;
  content: ContentBlock[];
  isError?: boolean;
}

export type ContentBlock =
  | TextBlock
  | ReasoningBlock
  | ImageBlock
  | ToolCallBlock
  | ToolResultBlock;

export type Role = 'user' | 'assistant' | 'system';

export interface Message {
  role: Role;
  content: ContentBlock[];
}

/** 提供给模型的工具描述（JSON Schema 参数） */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** disjoint 计数约定：cacheRead 不计入 input */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

// ---------------------------------------------------------------------------
// Stream chunks — provider 中立流协议
// ---------------------------------------------------------------------------

export type FinishReason = 'stop' | 'tool-calls' | 'max-tokens' | 'aborted' | 'error';

/**
 * 一个 assistant message 由若干 block 组成，block 以 index 标识。
 * 适配器必须保证：block-start 先于其 delta；block-end 后不再有该 index 的 delta；
 * 流以恰好一个 finish chunk 终结（error/aborted 也必须发 finish）。
 */
export type StreamChunk =
  | {
      type: 'block-start';
      index: number;
      block: 'text' | 'reasoning' | 'tool-call';
      /** block === 'tool-call' 时携带 */
      toolCall?: { id: string; name: string };
      /** block === 'reasoning' 且为 redacted thinking 时携带（无后续 delta） */
      redactedData?: string;
    }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  /** reasoning block 的签名（Anthropic signature_delta；回放 thinking 必需） */
  | { type: 'reasoning-signature'; index: number; signature: string }
  /** tool-call 参数的 JSON 文本增量 */
  | { type: 'tool-call-delta'; index: number; argsText: string }
  | { type: 'block-end'; index: number }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; error?: import('./errors.js').RoastError };

// ---------------------------------------------------------------------------
// Generate options
// ---------------------------------------------------------------------------

export interface GenerateOptions {
  model: string;
  reasoningEffort?: import('./config.js').ReasoningEffort | null;
  /** 已组装好的系统 prompt */
  system?: string;
  messages: Message[];
  tools?: ToolSchema[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

/** 从任意文本构造纯文本 user message 的便捷函数 */
export function userMessage(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] };
}

/** 提取一条消息中所有 tool-call block */
export function toolCallsOf(message: Message): ToolCallBlock[] {
  return message.content.filter((b): b is ToolCallBlock => b.type === 'tool-call');
}
