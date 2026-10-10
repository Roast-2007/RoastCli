/**
 * 会话的权限与交互装配：PermissionEngine + InteractionBroker + permissionHook。
 * - 规则来自 loadPermissionRules（仓库 allow 需 trust）；resume 时恢复会话授权与模式
 * - 授权 / 帮我审批的拒绝 / 模式变化通过 attach(commit) 落日志（permission/grant、permission/deny、mode/change）；
 *   项目级授权持久化到用户目录
 */
import { InteractionBroker } from '../core/interaction.js';
import { BROKER_KEY, PERMISSIONS_KEY, type ToolServices } from '../tools/index.js';
import { PermissionEngine, type PermissionMode } from '../tools/permissions/engine.js';
import { permissionHook } from '../tools/permissions/hook.js';
import { addProjectGrant, loadPermissionRules } from '../tools/permissions/settings.js';
import type { PreExecuteHook } from '../tools/tool.js';
import type { SessionEventBody } from '../session/events.js';

export interface PermissionSetup {
  engine: PermissionEngine;
  broker: InteractionBroker;
  hook: PreExecuteHook;
  ignoredRepoAllow: string[];
  /** 运行时创建后接上日志提交 */
  attach(commit: (body: SessionEventBody) => unknown): void;
}

export interface PermissionSetupOptions {
  allow?: string[];
  deny?: string[];
  cwd: string;
  services: ToolServices;
  /** CLI 显式指定的模式（最高优先） */
  mode?: PermissionMode;
  /** 免审批读取的额外根目录（本次运行的蜂群 worktree） */
  readRoots?: string[];
  /** resume 恢复的状态 */
  restored?: { grants: string[]; denials?: string[]; mode?: PermissionMode };
}

export function setupPermissions(opts: PermissionSetupOptions): PermissionSetup {
  const rules = loadPermissionRules(opts.cwd);
  const engine = new PermissionEngine({
    allow: [...rules.allow, ...(opts.allow ?? [])],
    ask: rules.ask,
    deny: [...rules.deny, ...(opts.deny ?? [])],
    mode: opts.mode ?? opts.restored?.mode ?? rules.defaultMode ?? 'default',
    // 本次运行的蜂群 worktree 是用户仓库的副本：评审 / 裁判读取候选方案无需逐个审批
    ...(opts.readRoots ? { readRoots: opts.readRoots } : {}),
  });
  for (const g of opts.restored?.grants ?? []) engine.grant(g, 'session');
  for (const key of opts.restored?.denials ?? []) engine.rememberDenial(key);
  const broker = new InteractionBroker();
  opts.services.set(BROKER_KEY, broker);
  opts.services.set(PERMISSIONS_KEY, engine);

  let commit: ((body: SessionEventBody) => unknown) | null = null;
  const at = () => new Date().toISOString();
  const hook = permissionHook({
    engine,
    broker,
    onGrant: (rule, scope) => {
      commit?.({ type: 'permission/grant', at: at(), rule, scope });
      if (scope === 'project') addProjectGrant(opts.cwd, rule);
    },
    onDeny: (key) => commit?.({ type: 'permission/deny', at: at(), key }),
  });
  return {
    engine,
    broker,
    hook,
    ignoredRepoAllow: rules.ignoredRepoAllow,
    attach(fn) {
      commit = fn;
      engine.onModeChange((mode) => fn({ type: 'mode/change', at: at(), mode }));
    },
  };
}
