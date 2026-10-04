/**
 * 钩子接入点：
 * - PreToolUse  → 工具执行管线 preExecute（在权限检查之前；退出码 2 拒绝，理由反馈给模型；yolo 模式同样生效）
 * - PostToolUse → postExecute（退出码 2 时把 stderr 作为反馈追加到工具结果）
 * - UserPromptSubmit → InputGuard（退出码 2 拦截输入；stdout 作为附加上下文追加到用户消息）
 * - Stop → onWouldEndTurn（退出码 2 时把 stderr 注入为新消息并继续，每个 turn 最多 MAX_STOP_BLOCKS 次）
 * - SessionStart → 会话启动时运行一次，stdout 作为稳定 system 段
 * 非阻塞错误通过 onError 回调交给会话（以 UI 提示显示）。
 */
import type { BoundaryHooks } from '../../agent/boundary.js';
import type { PostExecuteHook, PreExecuteHook, ToolResult } from '../../tools/tool.js';
import type { InputGuard } from '../guard.js';
import type { HookRunner } from './runner.js';

/** PostToolUse 负载中工具结果文本的上限 */
const RESULT_PAYLOAD_CHARS = 10_000;
/** 每个 turn 内 Stop 钩子最多阻止结束的次数（防止死循环） */
export const MAX_STOP_BLOCKS = 3;

type OnError = (errors: string[]) => void;

function resultText(result: ToolResult): string {
  return result.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('\n')
    .slice(0, RESULT_PAYLOAD_CHARS);
}

export function preToolUseHook(runner: HookRunner, onError: OnError): PreExecuteHook {
  return async (tool, args, ctx) => {
    if (!runner.has('PreToolUse', tool.name)) return { action: 'allow' };
    const payload = { tool_name: tool.name, tool_input: args, agent_id: ctx.agentId ?? 'main' };
    const r = await runner.run('PreToolUse', payload, { toolName: tool.name, signal: ctx.signal });
    if (r.errors.length) onError(r.errors);
    return r.blocked ? { action: 'deny', reason: `PreToolUse 钩子阻止：${r.blocked}` } : { action: 'allow' };
  };
}

export function postToolUseHook(runner: HookRunner, onError: OnError): PostExecuteHook {
  return async (tool, args, result, ctx) => {
    if (!runner.has('PostToolUse', tool.name)) return result;
    const payload = {
      tool_name: tool.name,
      tool_input: args,
      tool_response: { is_error: result.isError === true, text: resultText(result) },
      agent_id: ctx.agentId ?? 'main',
    };
    const r = await runner.run('PostToolUse', payload, { toolName: tool.name, signal: ctx.signal });
    if (r.errors.length) onError(r.errors);
    if (!r.blocked) return result;
    return { ...result, content: [...result.content, { type: 'text', text: `PostToolUse 钩子反馈：${r.blocked}` }], metadata: { ...result.metadata, hookFeedback: true } };
  };
}

export function promptSubmitGuard(runner: HookRunner, onError: OnError): InputGuard {
  return {
    async check(text, source, opts) {
      if (source !== 'user' || !runner.has('UserPromptSubmit')) return { action: 'pass' };
      const r = await runner.run('UserPromptSubmit', { prompt: text }, opts?.signal ? { signal: opts.signal } : {});
      if (r.errors.length) onError(r.errors);
      if (r.blocked) return { action: 'block', reason: `UserPromptSubmit 钩子拦截：${r.blocked}` };
      return r.output ? { action: 'sanitize', sanitized: `${text}\n\n[UserPromptSubmit 钩子附加的上下文]\n${r.output}` } : { action: 'pass' };
    },
  };
}

export function stopHookBoundary(runner: HookRunner, onError: OnError): BoundaryHooks {
  /** 待注入的反馈只属于产生它的 turn：该 turn 因步数用尽或中断而结束时丢弃，不会漏进下一个 turn */
  let pending: { turn: number; text: string } | null = null;
  let turnOf = -1;
  let blocks = 0;
  return {
    beforeRequest(ctx) {
      const p = pending;
      pending = null;
      return p && p.turn === ctx.turn ? [{ kind: 'inject', source: 'hook:Stop', blocks: [{ type: 'text', text: p.text }] }] : [];
    },
    async onWouldEndTurn(ctx) {
      if (ctx.turn !== turnOf) {
        turnOf = ctx.turn;
        blocks = 0;
      }
      if (blocks >= MAX_STOP_BLOCKS || !runner.has('Stop')) return { kind: 'end' };
      const r = await runner.run('Stop', { stop_hook_active: blocks > 0, agent_id: ctx.agentId }, { signal: ctx.signal });
      if (r.errors.length) onError(r.errors);
      if (!r.blocked) return { kind: 'end' };
      blocks += 1;
      pending = { turn: ctx.turn, text: `[Stop 钩子要求继续] ${r.blocked}` };
      return { kind: 'continue' };
    },
  };
}
