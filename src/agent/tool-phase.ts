/**
 * 工具阶段：提交 tool/call → 调度执行（事件实时流给 UI）→ 按模型顺序提交 tool/result。
 * 调度本身（并发安全批量、合成中断结果）见 tool-calls.ts。
 */
import { AsyncQueue } from '../core/async-queue.js';
import type { ToolCallBlock } from '../core/types.js';
import type { SessionEvent, SessionEventBody } from '../session/events.js';
import type { ToolContext, ToolExecutorHooks, ToolRegistry } from '../tools/index.js';
import { executeToolCalls, type ToolCallEvent, type ToolCallOutcome } from './tool-calls.js';
import { OUTPUT_DETAIL_MAX, previewOf, type UiEvent } from './ui-events.js';

export interface ToolPhaseEnv {
  turn: number;
  step: number;
  registry: ToolRegistry;
  ctx: ToolContext;
  hooks: ToolExecutorHooks;
  commit: (body: SessionEventBody) => SessionEvent;
  now: () => string;
}

function toUiEvent(e: ToolCallEvent): UiEvent {
  if (e.type === 'start') return { type: 'tool-call-start', callId: e.callId, name: e.name, args: e.args };
  if (e.type === 'progress') return { type: 'tool-progress', callId: e.callId, text: e.text };
  const firstText = e.outcome.result.content.find((b) => b.type === 'text');
  const full = e.outcome.result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  const output = full.length > OUTPUT_DETAIL_MAX ? `${full.slice(0, OUTPUT_DETAIL_MAX)}\n…（已截断）` : full;
  return {
    type: 'tool-call-end',
    callId: e.outcome.callId,
    name: e.outcome.name,
    isError: e.outcome.result.isError ?? false,
    preview: firstText && firstText.type === 'text' ? previewOf(firstText.text) : '',
    ...(output ? { output } : {}),
    durationMs: e.outcome.durationMs,
    ...(e.outcome.result.metadata ? { metadata: e.outcome.result.metadata } : {}),
  };
}

export async function* runToolPhase(calls: ToolCallBlock[], env: ToolPhaseEnv): AsyncGenerator<UiEvent, ToolCallOutcome[]> {
  const { turn, step } = env;
  for (const c of calls) {
    env.commit({ type: 'tool/call', turn, step, at: env.now(), callId: c.id, name: c.name, args: c.args });
  }
  const queue = new AsyncQueue<UiEvent>();
  const done = executeToolCalls(calls, env.registry, env.ctx, (e) => queue.push(toUiEvent(e)), env.hooks).then(
    (outcomes) => {
      queue.close();
      return outcomes;
    },
    (err: unknown) => {
      queue.close(err);
      throw err;
    },
  );
  // 由下方 for-await / await 消费；此处仅防止"处理前已 reject"被判为未处理
  done.catch(() => {});
  for await (const ev of queue) yield ev;
  const outcomes = await done;
  for (const o of outcomes) {
    env.commit({
      type: 'tool/result',
      turn,
      step,
      at: env.now(),
      callId: o.callId,
      name: o.name,
      isError: o.result.isError ?? false,
      content: o.result.content,
      durationMs: o.durationMs,
      ...(o.result.metadata ? { metadata: o.result.metadata } : {}),
    });
  }
  return outcomes;
}
