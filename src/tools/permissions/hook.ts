/**
 * 权限钩子：把 PermissionEngine + InteractionBroker 接到工具执行管线的 preExecute。
 * - allow：放行；deny：返回模型可读的拒绝原因
 * - ask：经 broker 询问用户；允许可"记住"（会话/项目级），拒绝可附带反馈给模型
 * - 帮我审批：询问带 10 秒倒计时（界面显示后开始）。超时拒绝且不记住，模型可以再次调用；
 *   用户明确拒绝则记住，之后完全相同的操作由引擎直接拒绝
 * - 无交互界面：ask 视为拒绝，并提示如何授权
 */
import { RoastError } from '../../core/errors.js';
import type { InteractionBroker } from '../../core/interaction.js';
import type { PreExecuteHook, ToolContext, ToolDefinition } from '../tool.js';
import type { PermissionEngine } from './engine.js';
import type { PermissionRequest } from './rules.js';
import { approvalPreview } from './preview.js';

export interface PermissionHookOptions {
  engine: PermissionEngine;
  broker: InteractionBroker;
  /** 用户选择"始终允许"时回调（session 落日志 / project 持久化到 .roast/settings.json） */
  onGrant?: (rule: string, scope: 'session' | 'project') => void;
  /** 帮我审批模式下用户明确拒绝时回调（落日志，恢复会话后仍然自动拒绝） */
  onDeny?: (key: string) => void;
}

/** 帮我审批：高风险操作的审批倒计时 */
export const AUTO_APPROVAL_SECONDS = 10;

export const EXECUTION_ROOT_KEY = 'permissions:execution-root';
export const READ_ONLY_ROLE_KEY = 'permissions:read-only-role';

export function permissionRequestOf(tool: ToolDefinition, args: unknown, ctx: ToolContext): PermissionRequest {
  let kind = tool.permission?.kind ?? (tool.isReadOnly ? 'read' : 'execute');
  try {
    kind = tool.permission?.kindFor?.(args as never) ?? kind;
  } catch {
    // 参数异常时沿用静态 kind（随后的 zod 校验会给出错误）
  }
  let target: string | undefined;
  try {
    target = tool.permission?.target?.(args as never, ctx);
  } catch {
    target = undefined;
  }
  return {
    tool: tool.name,
    kind,
    ...(tool.permission?.targetKind ? { targetKind: tool.permission.targetKind } : {}),
    ...(target !== undefined ? { target } : {}),
    cwd: ctx.cwd,
    ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
    ...(ctx.callId ? { callId: ctx.callId } : {}),
    args,
    ...(ctx.services.get<string>(EXECUTION_ROOT_KEY) ? { executionRoot: ctx.services.get<string>(EXECUTION_ROOT_KEY)! } : {}),
    ...(ctx.services.get<string>(READ_ONLY_ROLE_KEY) ? { readOnlyRole: ctx.services.get<string>(READ_ONLY_ROLE_KEY)! } : {}),
    ...(tool.permission?.destructive ? { destructive: true } : {}),
  };
}

const TIMEOUT_REASON = `帮我审批：用户在 ${AUTO_APPROVAL_SECONDS} 秒内没有响应，操作已自动拒绝。这不代表用户反对；确实需要时可以稍后再次发起同样的调用，让用户重新审批，也可以先处理其他工作。`;

const NON_INTERACTIVE_HINT =
  '非交互模式下需要用户授权的操作被拒绝。可使用 --permission-mode acceptEdits|yolo，或在配置 permissions.allow 中加入规则。';

export function permissionHook(opts: PermissionHookOptions): PreExecuteHook {
  return async (tool, args, ctx) => {
    const req = permissionRequestOf(tool, args, ctx);
    const verdict = opts.engine.evaluate(req);
    if (verdict.behavior === 'allow') return { action: 'allow' };
    if (verdict.behavior === 'deny') return { action: 'deny', reason: `权限 deny：${verdict.reason}` };
    const preview = opts.broker.interactive ? await approvalPreview(tool.name, args, ctx, opts.engine) : undefined;

    const response = await opts.broker.request(
      {
        kind: 'permission',
        agentId: ctx.agentId ?? 'main',
        tool: tool.name,
        title: req.target ? `${tool.name}: ${req.target.split('\n')[0]}` : tool.name,
        ...(req.target ? { detail: req.target } : {}),
        reason: verdict.reason,
        ...preview,
        ...(verdict.suggestedRule && !verdict.forced ? { suggestedRule: verdict.suggestedRule } : {}),
        ...(verdict.suggestedRules && !verdict.forced ? { suggestedRules: verdict.suggestedRules } : {}),
        ...(verdict.forced ? { forced: true } : {}),
        ...(verdict.denialKey ? { countdownMs: AUTO_APPROVAL_SECONDS * 1000 } : {}),
      },
      ctx.signal,
    );
    if (ctx.signal.aborted) throw new RoastError('ABORTED', '等待授权时被中断');
    if (response.kind === 'unavailable')
      return { action: 'deny', reason: verdict.forced ? '此命令需要明确授权。请在交互界面批准，或让主会话执行。' : NON_INTERACTIVE_HINT };
    if (response.kind === 'permission' && response.timedOut) return { action: 'deny', reason: TIMEOUT_REASON };
    if (response.kind !== 'permission' || response.decision === 'deny') {
      const feedback = response.kind === 'permission' && response.feedback ? `用户说明：${response.feedback}` : '';
      if (!verdict.denialKey) return { action: 'deny', reason: `用户拒绝了此操作。${feedback}` };
      opts.engine.rememberDenial(verdict.denialKey);
      opts.onDeny?.(verdict.denialKey);
      return {
        action: 'deny',
        reason: `用户拒绝了此操作。${feedback ? `${feedback}\n` : ''}本会话会自动拒绝完全相同的操作，请换一种做法，或向用户说明为什么需要它。`,
      };
    }
    if (response.remember && verdict.suggestedRule && !verdict.forced) {
      for (const rule of verdict.suggestedRules ?? [verdict.suggestedRule]) {
        opts.engine.grant(rule, response.remember);
        opts.onGrant?.(rule, response.remember);
      }
    }
    return { action: 'allow' };
  };
}
