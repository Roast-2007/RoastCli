/**
 * 会话事件类型全集：JSONL 运行日志中每行一个事件。
 * 纪律：一切模型可见内容必须可从日志重建（"model-visible ⟺ logged"），
 * resume / debug / 审计 / 快照测试全从这里派生。
 *
 * v1（当前写入格式）：每个事件带 seq（单调递增）与 agentId；
 * system prompt / 工具 schema 仅在 hash 变化时落快照；每个 step 落 request/digest
 * （含 viewHash，可校验"投影 == 实际发送"）；完整请求体仅 debugLog 时落盘。
 * v0（旧格式）：只读兼容。
 */
import type { ContentBlock, GenerateOptions, Message, StreamChunk, TokenUsage, ToolSchema } from '../core/types.js';
import type { ElideOp } from '../context/state.js';

export const LOG_FORMAT_VERSION = 1;
export const SUPPORTED_LOG_VERSIONS: readonly number[] = [0, 1];

/** 日志文件第一行：header */
export interface LogHeader {
  type: 'session';
  version: number;
  runId: string;
  createdAt: string; // ISO
  cwd: string;
  provider: string;
  model: string;
  pid: number;
  /** v1：本日志所属 agent（主会话为 'main'） */
  agentId?: string;
}

/** v1 信封字段（v0 日志缺省） */
export interface EventEnvelope {
  seq?: number;
  agentId?: string;
}

export type TurnEndReason = 'completed' | 'aborted' | 'error' | 'max-steps';
export type UserMessageSource = 'user' | 'steer';

export type SessionEventBody =
  | { type: 'turn/start'; turn: number; at: string }
  | { type: 'turn/end'; turn: number; at: string; reason: TurnEndReason; error?: string }
  | { type: 'step/start'; turn: number; step: number; at: string }
  /** v0：请求头摘要 */
  | {
      type: 'request/header';
      turn: number;
      step: number;
      at: string;
      model: string;
      systemChars: number;
      toolNames: string[];
      messageCount: number;
    }
  /** v1：请求摘要；viewHash = hash(发送的 messages) */
  | {
      type: 'request/digest';
      turn: number;
      step: number;
      at: string;
      model: string;
      systemHash: string;
      toolsHash: string;
      viewHash: string;
      messageCount: number;
      maxTokens?: number;
    }
  /** v1：system prompt 全文快照（hash 变化时） */
  | { type: 'system/snapshot'; at: string; hash: string; text: string }
  /** v1：工具 schema 快照（hash 变化时） */
  | { type: 'tools/snapshot'; at: string; hash: string; schemas: ToolSchema[] }
  /** 完整请求体（仅 debugLog） */
  | { type: 'request/body'; turn: number; step: number; at: string; request: Omit<GenerateOptions, 'signal'> }
  | { type: 'user/message'; turn: number; at: string; message: Message; source?: UserMessageSource }
  | {
      type: 'hive/mission';
      turn: number;
      at: string;
      missionId: string;
      goal: string;
      strategy: string;
      n: number;
      brief: string;
      readOnly?: boolean;
      images?: import('../core/types.js').ImageBlock[];
    }
  /** 流式 chunk（仅 debugLog；不参与投影） */
  | { type: 'assistant/chunk'; turn: number; step: number; chunk: StreamChunk }
  | { type: 'assistant/message'; turn: number; step: number; at: string; message: Message; usage?: TokenUsage; finishReason?: string }
  | { type: 'tool/call'; turn: number; step: number; at: string; callId: string; name: string; args: unknown }
  | {
      type: 'tool/result';
      turn: number;
      step: number;
      at: string;
      callId: string;
      name: string;
      isError: boolean;
      content: ContentBlock[];
      durationMs: number;
      metadata?: Record<string, unknown>;
    }
  | { type: 'usage'; turn: number; step: number; usage: TokenUsage }
  /** v1：一次重试（流已重置） */
  | { type: 'step/retry'; turn: number; step: number; at: string; attempt: number; code: string; message: string; delayMs: number }
  /** v1：模型可见的附加内容（提醒、inbox 等），追加到末尾 user 消息 */
  | { type: 'attachment/injected'; turn: number; step: number; at: string; source: string; blocks: ContentBlock[] }
  /** v1：从旧格式日志导入历史（resume v0 日志时） */
  | {
      type: 'history/import';
      at: string;
      fromRunId: string;
      messages: Message[];
      fromSeq?: number;
      turn?: number;
      /** 分叉时来源各 turn 开始前的快照（消息去重进 pool，turns 记下标），供回退到来源轮次 */
      turnStarts?: { pool: Message[]; turns: Record<number, number[]> };
      missionSeq?: number;
    }
  /** v1：在已有日志上继续（resume 标记） */
  | { type: 'session/resume'; at: string; pid: number }
  /** v1：用户"始终允许"授权（resume 时恢复会话级授权） */
  | { type: 'permission/grant'; at: string; rule: string; scope: 'session' | 'project' }
  /** v1：上下文变换决策（折叠 / 取消折叠 tool-result） */
  | { type: 'context/transform'; at: string; ops: ElideOp[] }
  /** v1：上下文压缩决策：messages[0, upTo) 由 summary 替代（摘要原文入日志，回放不重算） */
  | {
      type: 'context/compact';
      at: string;
      upTo: number;
      summary: string;
      focus?: string;
      auxUsage?: TokenUsage;
      auxModel?: import('../core/config.js').ModelRef;
    }
  /** v1：turn 内第一次写操作前的工作区快照（影子 git commit） */
  | { type: 'checkpoint'; at: string; turn: number; hash: string }
  /** v1：回退到 toTurn 开始前（对话由 history reducer 回退；文件已按 checkpoint 恢复） */
  | { type: 'rewind'; at: string; toTurn: number; checkpoint?: string; backup?: string; deleted?: string[] }
  /** v1：权限模式切换（default / acceptEdits / plan / yolo） */
  | { type: 'mode/change'; at: string; mode: 'default' | 'acceptEdits' | 'plan' | 'yolo' }
  | {
      type: 'model/change';
      at: string;
      provider: string;
      model: string;
      reasoningEffort?: import('../core/config.js').ReasoningEffort | null;
    }
  | { type: 'error'; at: string; where: string; code: string; message: string };

export type SessionEvent = SessionEventBody & EventEnvelope;
export type SessionEventType = SessionEvent['type'];

export const KNOWN_EVENT_TYPES: readonly SessionEventType[] = [
  'turn/start',
  'turn/end',
  'step/start',
  'request/header',
  'request/digest',
  'system/snapshot',
  'tools/snapshot',
  'request/body',
  'user/message',
  'hive/mission',
  'assistant/chunk',
  'assistant/message',
  'tool/call',
  'tool/result',
  'usage',
  'step/retry',
  'attachment/injected',
  'history/import',
  'session/resume',
  'permission/grant',
  'mode/change',
  'model/change',
  'checkpoint',
  'rewind',
  'context/transform',
  'context/compact',
  'error',
];
