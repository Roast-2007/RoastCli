/**
 * 单个 step 的模型请求：流式消费 adapter，聚合为 assistant 消息，失败时按策略重试。
 * 以 AsyncGenerator<UiEvent, StepOutcome> 形式实现，运行时用 `yield*` 透传 UI 事件。
 *
 * 重试：仅对 retryable 错误（RATE_LIMIT / SERVER / NETWORK），落 step/retry 事件；
 * 若本次尝试已流出内容，先发 stream-reset 让 UI 丢弃半截文本。
 */
import { asRoastError, RoastError } from '../core/errors.js';
import { addUsage, emptyUsage } from '../core/types.js';
import type { FinishReason, GenerateOptions, Message, TokenUsage } from '../core/types.js';
import type { ProviderAdapter } from '../providers/adapter.js';
import type { SessionEvent, SessionEventBody } from '../session/events.js';
import { BlockAssembler } from './assembler.js';
import { retryDelay, type Clock, type RetryPolicy } from './retry.js';
import type { UiEvent } from './ui-events.js';

export type StepOutcome =
  | { kind: 'message'; message: Message; usage: TokenUsage; finishReason: FinishReason }
  | { kind: 'failed'; error: RoastError; aborted: boolean; usage: TokenUsage; text?: string };

export interface StepEnv {
  adapter: ProviderAdapter;
  retry: RetryPolicy;
  clock: Clock;
  random?: () => number;
  debugLog: boolean;
  turn: number;
  step: number;
  signal: AbortSignal;
  commit: (body: SessionEventBody) => SessionEvent;
}

interface AttemptResult {
  asm: BlockAssembler;
  emittedContent: boolean;
}

async function* attempt(request: Omit<GenerateOptions, 'signal'>, env: StepEnv): AsyncGenerator<UiEvent, AttemptResult> {
  const asm = new BlockAssembler();
  let emittedContent = false;
  try {
    for await (const chunk of env.adapter.stream({ ...request, signal: env.signal })) {
      if (env.debugLog) env.commit({ type: 'assistant/chunk', turn: env.turn, step: env.step, chunk });
      asm.push(chunk);
      if (chunk.type === 'text-delta') {
        emittedContent = true;
        yield { type: 'text-delta', text: chunk.text };
      } else if (chunk.type === 'reasoning-delta') {
        emittedContent = true;
        yield { type: 'reasoning-delta', text: chunk.text };
      }
    }
  } catch (err) {
    // 适配器契约要求不抛；兜底归一化为 finish error
    const e = asRoastError(err);
    asm.push({ type: 'finish', reason: e.code === 'ABORTED' ? 'aborted' : 'error', error: e });
  }
  if (asm.finishReason === null) {
    asm.push({ type: 'finish', reason: 'error', error: new RoastError('SERVER', '模型流未以 finish 结束', { retryable: true }) });
  }
  return { asm, emittedContent };
}

export async function* runStep(request: Omit<GenerateOptions, 'signal'>, env: StepEnv): AsyncGenerator<UiEvent, StepOutcome> {
  let usage = emptyUsage();
  for (let n = 0; ; n++) {
    const { asm, emittedContent } = yield* attempt(request, env);
    usage = addUsage(usage, asm.usage);
    env.commit({ type: 'usage', turn: env.turn, step: env.step, usage: asm.usage });
    yield { type: 'usage', usage: asm.usage };

    const reason = asm.finishReason;
    if (reason !== 'error' && reason !== 'aborted') {
      return { kind: 'message', message: asm.message(), usage, finishReason: reason ?? 'stop' };
    }
    const error = asm.finishError ?? new RoastError('UNKNOWN', `流异常终结: ${reason}`);
    const text = asm
      .message()
      .content.filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    if (reason === 'aborted' || env.signal.aborted) return { kind: 'failed', error, aborted: true, usage, text };

    const delayMs = retryDelay(n + 1, error, env.retry, env.random);
    if (delayMs === null) return { kind: 'failed', error, aborted: false, usage, text };

    env.commit({
      type: 'step/retry',
      turn: env.turn,
      step: env.step,
      at: new Date(env.clock.now()).toISOString(),
      attempt: n + 1,
      code: error.code,
      message: error.message,
      delayMs,
    });
    if (emittedContent) yield { type: 'stream-reset' };
    yield { type: 'retry', attempt: n + 1, delayMs, code: error.code, message: error.message };
    await env.clock.sleep(delayMs, env.signal);
    if (env.signal.aborted) {
      return { kind: 'failed', error: new RoastError('ABORTED', '重试等待中被中断'), aborted: true, usage };
    }
  }
}
