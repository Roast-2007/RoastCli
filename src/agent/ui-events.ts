/**
 * UI 事件：agent 运行时的对外输出契约。
 * Ink TUI 与 `-p` 管道模式消费同一个 AsyncGenerator<UiEvent>。
 */
import type { RoastError } from '../core/errors.js';
import type { TokenUsage } from '../core/types.js';

export type TurnEndReason = 'completed' | 'aborted' | 'error' | 'max-steps';

export type UiEvent =
  | { type: 'hive/mission'; turn: number; at: string; missionId: string; goal: string; strategy: string; n: number; brief: string; readOnly?: boolean }
  | { type: 'turn-start'; turn: number }
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  /** 重试前丢弃已流出的部分内容 */
  | { type: 'stream-reset' }
  | { type: 'retry'; attempt: number; delayMs: number; code: string; message: string }
  | { type: 'tool-call-start'; callId: string; name: string; args: unknown }
  | { type: 'tool-progress'; callId: string; text: string }
  | {
      type: 'tool-call-end';
      callId: string;
      name: string;
      isError: boolean;
      preview: string;
      /** 结果全文（截断到 OUTPUT_DETAIL_MAX，供 Ctrl+O 查看；不进模型上下文以外的任何地方） */
      output?: string;
      durationMs: number;
      /** 工具结果的结构化元数据（diff、todos、exitCode 等，UI 渲染用） */
      metadata?: Record<string, unknown>;
    }
  /** 运行中排队的用户插话已送达模型 */
  | { type: 'user-injected'; text: string }
  /** 中断后未送达的排队插话（UI 可放回输入框） */
  | { type: 'queue-restored'; texts: string[] }
  /** 运行时提示（不进模型上下文），如"上下文已压缩" */
  | { type: 'notice'; text: string }
  /** 运行时进入不耗 token 的等待（如等待子 agent） */
  | { type: 'waiting'; reason: string }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'turn-end'; reason: TurnEndReason; usage: TokenUsage }
  | { type: 'error'; error: RoastError };

/** 工具结果给 UI 的预览：取首个 text block 的开头 */
/** Ctrl+O 详情面板保留的工具输出上限（字符） */
export const OUTPUT_DETAIL_MAX = 8_000;

export function previewOf(text: string, max = 200): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine;
}
