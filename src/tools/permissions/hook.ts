/**
 * 权限钩子：把 PermissionEngine + InteractionBroker 接到工具执行管线的 preExecute。
 * - allow：放行；deny：返回模型可读的拒绝原因
 * - ask：经 broker 询问用户；允许可"记住"（会话/项目级），拒绝可附带反馈给模型
 * - 无交互界面：ask 视为拒绝，并提示如何授权
 */
import { RoastError } from '../../core/errors.js';
import type { InteractionBroker } from '../../core/interaction.js';
import type { PreExecuteHook, ToolContext, ToolDefinition } from '../tool.js';
import type { PermissionEngine } from './engine.js';
import type { PermissionRequest } from './rules.js';

export interface PermissionHookOptions {
  engine: PermissionEngine;
  broker: InteractionBroker;
  /** 用户选择"始终允许"时回调（session 落日志 / project 持久化到 .roast/settings.json） */
  onGrant?: (rule: string, scope: 'session' | 'project') => void;
}

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
  };
}

const NON_INTERACTIVE_HINT =
  '非交互模式下需要用户授权的操作被拒绝。可使用 --permission-mode acceptEdits|yolo，或在配置 permissions.allow 中加入规则。';

export function permissionHook(opts: PermissionHookOptions): PreExecuteHook {
  return async (tool, args, ctx) => {
    const req = permissionRequestOf(tool, args, ctx);
    const verdict = opts.engine.evaluate(req);
    if (verdict.behavior === 'allow') return { action: 'allow' };
    if (verdict.behavior === 'deny') return { action: 'deny', reason: `权限 deny：${verdict.reason}` };

    const response = await opts.broker.request(
      {
        kind: 'permission',
        agentId: ctx.agentId ?? 'main',
        tool: tool.name,
        title: req.target ? `${tool.name}: ${req.target.split('\n')[0]}` : tool.name,
        ...(req.target ? { detail: req.target } : {}),
        reason: verdict.reason,
        ...(verdict.suggestedRule && !verdict.forced ? { suggestedRule: verdict.suggestedRule } : {}),
        ...(verdict.forced ? { forced: true } : {}),
      },
      ctx.signal,
    );
    if (ctx.signal.aborted) throw new RoastError('ABORTED', '等待授权时被中断');
    if (response.kind === 'unavailable') return { action: 'deny', reason: verdict.forced ? '此命令需要明确授权。请在交互界面批准，或让主会话执行。' : NON_INTERACTIVE_HINT };
    if (response.kind !== 'permission' || response.decision === 'deny') {
      const feedback = response.kind === 'permission' && response.feedback ? `用户说明：${response.feedback}` : '';
      return { action: 'deny', reason: `用户拒绝了此操作。${feedback}` };
    }
    if (response.remember && verdict.suggestedRule && !verdict.forced) {
      opts.engine.grant(verdict.suggestedRule, response.remember);
      opts.onGrant?.(verdict.suggestedRule, response.remember);
    }
    return { action: 'allow' };
  };
}
