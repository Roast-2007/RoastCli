/**
 * 蜂群装配：为会话创建 Supervisor，并定义子 agent 的运行时工厂。
 * 子 agent 与主会话共享：provider、工具列表、system prompt（含蜂群说明）、权限引擎与审批中转；
 * 各自独立：日志（agents/<id>.jsonl）、services（读写状态、后台任务、待办）、上下文引擎、mailbox、工作目录
 * （写入型子 agent 在 git 仓库中使用独立 worktree，见 swarm/isolation.ts）。
 */
import { parseModelRef, roastHome, isProjectTrusted, untrustedProviderOverrides, reasoningEfforts, type ReasoningEffort, type ModelRef, type RoastConfig } from '../core/config.js';
import { RoastError } from '../core/errors.js';
import type { InteractionBroker } from '../core/interaction.js';
import type { ProviderRegistry } from '../providers/adapter.js';
import { ContextController } from '../context/controller.js';
import { CONTEXT_ACCESS_KEY } from '../context/recall-tool.js';
import { BROKER_KEY, FS_STATE_KEY, FileStateStore, MapToolServices, PERMISSIONS_KEY, type ToolRegistry } from '../tools/index.js';
import type { PermissionEngine } from '../tools/permissions/engine.js';
import { EXECUTION_ROOT_KEY, READ_ONLY_ROLE_KEY } from '../tools/permissions/hook.js';
import type { PostExecuteHook, PreExecuteHook, ToolServices } from '../tools/tool.js';
import { Supervisor } from '../swarm/supervisor.js';
import { roleGuardHook, SWARM_KEY } from '../swarm/tools.js';
import { LeaseManager, leaseHook } from '../swarm/lease.js';
import { worktreeGuardHook } from '../swarm/isolation.js';
import { WorktreeManager } from '../swarm/worktree.js';
import { READ_ONLY_ROLES, type AgentRole } from '../swarm/types.js';
import type { RunLogWriter } from '../session/log-writer.js';
import { composeBoundary } from './boundary.js';
import { AgentRuntime } from './runtime.js';
import type { SystemPromptAssembler } from './system-prompt.js';
import type { UiEvent } from './ui-events.js';

export interface SwarmSetupInput {
  cwd: string;
  config: RoastConfig;
  mainRef: ModelRef;
  mainLog: RunLogWriter;
  providers: ProviderRegistry;
  tools: ToolRegistry;
  systemPrompt: SystemPromptAssembler;
  permissionHook: PreExecuteHook;
  /** 权限检查之前的钩子（用户 PreToolUse 钩子） */
  prePermission?: PreExecuteHook[];
  /** 结果后处理（注入防护等），与主会话一致 */
  postExecute?: PostExecuteHook[];
  /** 共享扩展服务（skills / memory） */
  provideServices?(services: ToolServices): void;
  broker: InteractionBroker;
  engine: PermissionEngine;
  overhead: () => number;
  windowFor(ref: ModelRef): number;
  signal: AbortSignal;
  debugLog: boolean;
  onAgentEvent(agentId: string, ev: UiEvent): void;
  onChange(): void;
}

export interface SwarmSetup {
  supervisor: Supervisor;
  /** 主会话也要挂上的租约钩子（与子 agent 共享同一把租约表） */
  leaseHook: PreExecuteHook;
}

export function setupSwarm(input: SwarmSetupInput): SwarmSetup {
  const swarm = input.config.swarm;
  const modelFor = (role: AgentRole, override?: string, effort?: ReasoningEffort | null): ModelRef => {
    const ref = swarm.models?.[role];
    const model = override ? parseModelRef(override) : ref && ref !== 'inherit' ? parseModelRef(ref) : { ...input.mainRef };
    const profile = input.config.providers[model.provider];
    if (!profile) throw new RoastError('CONFIG', `未配置 provider ${model.provider}`);
    if (!isProjectTrusted(input.cwd) && untrustedProviderOverrides(input.cwd).includes(model.provider)) throw new RoastError('UNTRUSTED_CONFIG', '子 agent 的 provider 连接尚未信任，请运行 roast trust');
    input.providers.get(model);
    const selected = effort !== undefined ? effort : override || ref === 'inherit' ? undefined : swarm.efforts?.[role];
    if (selected !== undefined) model.reasoningEffort = selected;
    if (model.reasoningEffort != null && !reasoningEfforts(profile.driver, profile.baseURL, profile.models?.[model.model]).includes(model.reasoningEffort)) throw new RoastError('CONFIG', '子 agent 模型不支持所选 reasoning effort');
    return model;
  };
  const live = new Set(['queued', 'running', 'waiting', 'paused']);
  const leases = new LeaseManager((id) => live.has(supervisor.info(id)?.state ?? 'done'));
  const lease = leaseHook(leases);
  const supervisor: Supervisor = new Supervisor({
    mainLogPath: input.mainLog.path,
    runId: input.mainLog.header.runId,
    cwd: input.cwd,
    modelFor,
    maxAgents: swarm.maxAgents,
    maxDepth: swarm.maxDepth,
    maxAgentMs: swarm.maxMinutes * 60_000,
    ...(swarm.worktrees === false ? {} : { worktrees: new WorktreeManager({ runId: input.mainLog.header.runId, home: roastHome() }) }),
    onAgentEvent: input.onAgentEvent,
    onChange: input.onChange,
    onAgentEnd: (id) => leases.releaseAll(id),
    createServices(agentId) {
      const s = new MapToolServices();
      s.set(BROKER_KEY, input.broker);
      s.set(PERMISSIONS_KEY, input.engine);
      s.set(FS_STATE_KEY, new FileStateStore());
      s.set(SWARM_KEY, { supervisor, agentId });
      input.provideServices?.(s);
      return s;
    },
    createRuntime({ id, role, log, services, boundary, modelRef, cwd, worktree }) {
      if (worktree) services.set(EXECUTION_ROOT_KEY, worktree.root);
      if (READ_ONLY_ROLES.has(role)) services.set(READ_ONLY_ROLE_KEY, role);
      const ctl = new ContextController({ window: input.windowFor(modelRef), config: input.config.context, overhead: input.overhead });
      const rt = new AgentRuntime({
        agentId: id,
        providers: input.providers,
        modelRef,
        tools: input.tools,
        systemPrompt: input.systemPrompt,
        log,
        cwd,
        services,
        hooks: { preExecute: [...(input.prePermission ?? []), ...(worktree ? [worktreeGuardHook(worktree)] : []), roleGuardHook(role), input.permissionHook, lease], postExecute: input.postExecute ?? [] },
        boundary: composeBoundary(ctl.hooks(), boundary),
        maxSteps: input.config.maxSteps,
        signal: input.signal,
        debugLog: input.debugLog,
        ...(input.config.temperature !== undefined ? { temperature: input.config.temperature } : {}),
      });
      ctl.attach((b) => rt.committer.commit(b), () => rt.committer.state);
      rt.committer.onCommit((ev) => ctl.observe(ev));
      services.set(CONTEXT_ACCESS_KEY, { state: () => rt.committer.state });
      return rt;
    },
  });
  supervisor.registerRoot('main', `${input.mainRef.provider}:${input.mainRef.model}`);
  const offInteractions = input.broker.onChange(() => {
    const requests = input.broker.pending();
    for (const agent of supervisor.tree()) {
      const request = requests.find((r) => r.agentId === agent.id);
      supervisor.setInteractionWaiting(agent.id, request ? request.kind === 'permission' ? '等待用户授权' : '等待用户回答' : undefined);
    }
  });
  input.signal.addEventListener('abort', offInteractions, { once: true });
  return { supervisor, leaseHook: lease };
}
