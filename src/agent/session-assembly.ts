/**
 * 会话装配的各个步骤（由 createSession 编排）：
 * 核心（services / 权限 / system prompt / 扩展 / 钩子）→ 上下文引擎 → 蜂群 → 主运行时 → 对外 API。
 */
import { isProjectTrusted, roastHome, trustState, untrustedProviderOverrides, parseModelRef, reasoningEfforts, type ReasoningEffort, type ModelRef, type RoastConfig } from '../core/config.js';
import { ModelDiscovery } from '../providers/models.js';
import { saveConfigPatch } from '../cli/provider-settings.js';
import { RoastError } from '../core/errors.js';
import { UsageCost } from '../core/usage-cost.js';
import type { ProviderRegistry } from '../providers/adapter.js';
import { FS_STATE_KEY, FileStateStore, MapToolServices, type ToolRegistry } from '../tools/index.js';
import type { OpenedRunLog } from '../session/resume.js';
import { findInstructionFiles, type InstructionFile } from '../ext/instructions.js';
import { CheckpointManager } from '../ext/audit/checkpoints.js';
import { ShadowGit } from '../ext/audit/shadow-git.js';
import { ContextController } from '../context/controller.js';
import { modelSummarizer } from '../context/model-summary.js';
import { CONTEXT_ACCESS_KEY } from '../context/recall-tool.js';
import { estimateText } from '../context/estimator.js';
import { SWARM_KEY } from '../swarm/tools.js';
import type { Supervisor } from '../swarm/supervisor.js';
import { AgentRuntime } from './runtime.js';
import { composeBoundary } from './boundary.js';
import { setupPermissions, type PermissionSetup } from './permissions-setup.js';
import { setupExtensions, type ExtensionsSetup } from './extensions-setup.js';
import { chainInputGuards, setupHooks, type HooksSetup } from './hooks-setup.js';
import { setupSwarm } from './swarm-setup.js';
import { runWorktreesDir } from '../swarm/worktree.js';
import type { McpSetup } from './mcp-setup.js';
import type { SystemPromptAssembler } from './system-prompt.js';
import type { UiEvent } from './ui-events.js';
import { userTurns } from './turns.js';
import type { CreateSessionOptions, Session } from './session.js';
import type { SessionEvent } from '../session/events.js';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { loadRunLog } from '../session/projection.js';
import { modelCatalogSection } from '../swarm/model-routing.js';

/** 模型未配置 contextWindow 时的默认窗口 */
const DEFAULT_CONTEXT_WINDOW = 128_000;

export interface AssemblyInput {
  cwd: string;
  config: RoastConfig;
  ref: ModelRef;
  providers: ProviderRegistry;
  opened: OpenedRunLog;
  tools: ToolRegistry;
  mcp: McpSetup;
  opts: CreateSessionOptions;
  buildSystemPrompt(cwd: string, instructions: InstructionFile[]): SystemPromptAssembler;
  resume(logPath: string): Promise<Session>;
}

interface Core {
  services: MapToolServices;
  perms: PermissionSetup;
  instructions: InstructionFile[];
  systemPrompt: SystemPromptAssembler;
  ext: ExtensionsSetup;
  hooks: HooksSetup;
}

interface Listeners {
  agent: Set<(agentId: string, ev: UiEvent) => void>;
  swarm: Set<() => void>;
  usage: Set<(ref: ModelRef, event: SessionEvent) => void>;
}

async function assembleCore(input: AssemblyInput): Promise<Core> {
  const { cwd, opened, opts } = input;
  const services = new MapToolServices();
  const fileStore = new FileStateStore();
  for (const [p, s] of opened.fileStates) fileStore.record(p, s);
  services.set(FS_STATE_KEY, fileStore);
  const perms = setupPermissions({
    cwd,
    services,
    readRoots: [runWorktreesDir(roastHome(), opened.log.header.runId)],
    ...(opts.permissionMode ? { mode: opts.permissionMode } : {}),
    ...(opened.permissions ? { restored: opened.permissions } : {}),
  });
  const instructions = findInstructionFiles(cwd, { home: roastHome() });
  const systemPrompt = input.buildSystemPrompt(cwd, instructions);
  systemPrompt.register({ name: 'agent-models', order: 301, text: modelCatalogSection(input.config) });
  const ext = await setupExtensions({ cwd, home: roastHome(), systemPrompt, date: new Date().toISOString().slice(0, 10), trusted: isProjectTrusted(cwd), config: input.config });
  ext.provide(services);
  const hooks = await setupHooks({ cwd, sessionId: opened.log.header.runId, resumed: !!opened.resumedFrom, systemPrompt });
  return { services, perms, instructions, systemPrompt, ext, hooks };
}

function contextFor(input: AssemblyInput, core: Core) {
  const toolsTokens = estimateText(JSON.stringify(input.tools.schemas()));
  const windowFor = (r: ModelRef) => input.providers.get(r).resolveModel?.(r.model)?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const overhead = () => estimateText(core.systemPrompt.assemble()) + toolsTokens;
  const controller = new ContextController({ window: windowFor(input.ref), config: input.config.context, overhead, summarizer: modelSummarizer(input.config, input.ref, input.providers, input.cwd) });
  return { windowFor, overhead, controller };
}

function buildSwarm(input: AssemblyInput, core: Core, ctx: ReturnType<typeof contextFor>, listeners: Listeners, signal: AbortSignal, debugLog: boolean) {
  return setupSwarm({
    cwd: input.cwd,
    config: input.config,
    mainRef: input.ref,
    mainLog: input.opened.log,
    providers: input.providers,
    tools: input.tools,
    systemPrompt: core.systemPrompt,
    permissionHook: core.perms.hook,
    prePermission: core.hooks.preExecute,
    postExecute: [...core.ext.postExecute, ...core.hooks.postExecute],
    provideServices: core.ext.provide,
    broker: core.perms.broker,
    engine: core.perms.engine,
    overhead: ctx.overhead,
    windowFor: ctx.windowFor,
    signal,
    debugLog,
    onAgentEvent: (id, ev) => listeners.agent.forEach((l) => l(id, ev)),
    onSessionEvent: (ref, event) => listeners.usage.forEach((listener) => listener(ref, event)),
    onChange: () => listeners.swarm.forEach((l) => l()),
  });
}

export async function assembleSession(input: AssemblyInput): Promise<Session> {
  const { cwd, config, opened, opts } = input;
  const core = await assembleCore(input);
  const ctx = contextFor(input, core);
  const listeners: Listeners = { agent: new Set(), swarm: new Set(), usage: new Set() };
  const lifetime = new AbortController();
  const debugLog = config.debugLog || process.env['ROAST_DEBUG_LOG'] === '1';
  const { supervisor: swarm, leaseHook } = buildSwarm(input, core, ctx, listeners, lifetime.signal, debugLog);
  core.services.set(SWARM_KEY, { supervisor: swarm, agentId: 'main' });
  const checkpoints = new CheckpointManager(new ShadowGit(cwd), () => core.perms.engine.mode);
  checkpoints.restoreFromEvents(opened.events);
  const inputGuard = chainInputGuards(opts.extensions?.inputGuard, core.hooks.inputGuard);
  const loop = new AgentRuntime({
    providers: input.providers,
    modelRef: input.ref,
    tools: input.tools,
    systemPrompt: core.systemPrompt,
    boundary: composeBoundary(ctx.controller.hooks(), swarm.hooksFor('main'), core.hooks.boundary),
    log: opened.log,
    cwd,
    services: core.services,
    hooks: { preExecute: [...core.hooks.preExecute, core.perms.hook, leaseHook, checkpoints.hook()], postExecute: [...core.ext.postExecute, ...core.hooks.postExecute] },
    initialHistory: opened.initialHistory,
    signal: lifetime.signal,
    maxSteps: config.maxSteps,
    debugLog,
    ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
    extensions: { ...opts.extensions, ...(inputGuard ? { inputGuard } : {}) },
  });
  const commit = (body: Parameters<typeof loop.committer.commit>[0]) => loop.committer.commit(body);
  opened.finalize(commit);
  core.perms.attach(commit);
  checkpoints.attach(commit);
  ctx.controller.attach(commit, () => loop.committer.state);
  loop.committer.onCommit((ev) => ctx.controller.observe(ev));
  core.services.set(CONTEXT_ACCESS_KEY, { state: () => loop.committer.state });
  return sessionApi({ input, core, loop, swarm, checkpoints, contextCtl: ctx.controller, listeners, lifetime });
}

interface ApiParts {
  input: AssemblyInput;
  core: Core;
  loop: AgentRuntime;
  swarm: Supervisor;
  checkpoints: CheckpointManager;
  contextCtl: ContextController;
  listeners: Listeners;
  lifetime: AbortController;
}

export const TRUST_CHANGED_WARNING = '仓库配置中的钩子 / MCP / provider 连接 / allow 规则自信任以来已被修改，已按未信任处理；确认无误后重新运行 roast trust';

function startupWarnings(cwd: string, core: Core, mcp: McpSetup): string[] {
  const allow = core.perms.ignoredRepoAllow.length;
  return [...(trustState(cwd) === 'changed' ? [TRUST_CHANGED_WARNING] : []), ...(allow ? [`项目配置中的 ${allow} 条 allow 规则未生效（未信任项目，可运行 roast trust）`] : []), ...core.ext.warnings, ...core.hooks.warnings, ...mcp.warnings];
}

function sessionApi(p: ApiParts): Session {
  const { input, core, loop, swarm, listeners } = p;
  const validateModel = (value: string, effort?: ReasoningEffort | null) => {
    const next = parseModelRef(value.includes(':') ? value : `${input.ref.provider}:${value}`);
    const profile = input.config.providers[next.provider];
    if (!profile) throw new RoastError('CONFIG', `未配置 provider ${next.provider}`);
    if (!isProjectTrusted(input.cwd) && untrustedProviderOverrides(input.cwd).includes(next.provider)) throw new RoastError('UNTRUSTED_CONFIG', '该 provider 的项目连接信息尚未信任，请运行 roast trust');
    input.providers.get(next);
    if (!next.model.trim() || /[\s\x00-\x1f\x7f]/.test(next.model)) throw new RoastError('CONFIG', '无效的模型 ID');
    if (effort != null && !reasoningEfforts(profile.driver, profile.baseURL, profile.models?.[next.model]).includes(effort)) throw new RoastError('CONFIG', '该模型不支持所选 reasoning effort');
    return { ...next, ...(effort !== undefined ? { reasoningEffort: effort } : {}) };
  };
  const discovery = new ModelDiscovery(input.config, (provider) => { validateModel(`${provider}:discovery`); });
  const usageCost = new UsageCost({ provider: input.opened.log.header.provider, model: input.opened.log.header.model }, input.config);
  for (const event of input.opened.events) usageCost.observe(event);
  usageCost.setModel(input.ref);
  const agentsDir = path.join(path.dirname(input.opened.log.path), 'agents');
  if (existsSync(agentsDir)) for (const name of readdirSync(agentsDir).filter((file) => file.endsWith('.jsonl'))) {
    try {
      const loaded = loadRunLog(path.join(agentsDir, name));
      const ref = { provider: loaded.header.provider, model: loaded.header.model };
      for (const event of loaded.events) usageCost.observe({ ...event, agentId: event.agentId ?? name.slice(0, -6) }, ref);
    } catch { /* Incomplete child logs never prevent restoring the main conversation. */ }
  }
  listeners.usage.add((ref, event) => usageCost.observe(event, ref));
  loop.committer.onCommit((event) => usageCost.observe(event));
  const previousModel = input.opened.events.filter((event) => event.type === 'model/change').at(-1) ?? input.opened.log.header;
  if ('provider' in previousModel && (previousModel.provider !== input.ref.provider || previousModel.model !== input.ref.model)) {
    loop.committer.commit({ type: 'model/change', at: new Date().toISOString(), ...input.ref });
    loop.committer.flush();
  }
  return {
    loop,
    log: input.opened.log,
    config: input.config,
    initialEvents: input.opened.events,
    get providerName() { return input.ref.provider; },
    get model() { return input.ref.model; },
    get reasoningEffort() { return input.ref.reasoningEffort === undefined ? input.config.providers[input.ref.provider]?.models?.[input.ref.model]?.reasoningEffort : input.ref.reasoningEffort; },
    listModels: (opts) => discovery.list(opts),
    setSwarmModel(role, value, effort) {
      if (role === 'queen') throw new RoastError('CONFIG', 'Queen 使用主会话模型，请用 /model 修改');
      const validated = value === 'inherit' ? undefined : validateModel(value, effort);
      const ref = validated ? `${validated.provider}:${validated.model}` : 'inherit';
      saveConfigPatch(input.cwd, { swarm: { models: { [role]: ref }, efforts: { [role]: effort ?? null } } });
      Object.assign(input.config.swarm.models ??= {}, { [role]: ref });
      input.config.swarm.efforts = { ...input.config.swarm.efforts, [role]: effort ?? null };
      listeners.swarm.forEach((listener) => listener());
    },
    configureSwarmModels(models) {
      if (loop.busy || swarm.tree().some((agent) => agent.parentId && ['queued', 'running', 'waiting', 'paused'].includes(agent.state))) throw new RoastError('INVALID_REQUEST', '请等蜂群空闲后指定角色模型');
      for (const value of Object.values(models)) if (value !== 'inherit') validateModel(value);
      if (models.queen && models.queen !== 'inherit') {
        const next = validateModel(models.queen);
        delete input.ref.reasoningEffort; Object.assign(input.ref, next);
        p.contextCtl.setWindow(input.providers.get(next).resolveModel?.(next.model)?.contextWindow ?? DEFAULT_CONTEXT_WINDOW);
        loop.committer.commit({ type: 'model/change', at: new Date().toISOString(), ...next });
        swarm.setRootModel(`${next.provider}:${next.model}`);
      }
      Object.assign(input.config.swarm.models ??= {}, models);
      core.systemPrompt.register({ name: 'agent-models', order: 301, text: modelCatalogSection(input.config) });
      listeners.swarm.forEach((listener) => listener());
    },
    resume: input.resume,
    cost: () => usageCost.value(),
    costBreakdown: () => usageCost.breakdown(),
    switchModel(value, effort) {
      if (loop.busy || swarm.tree().some((a) => a.parentId && ['queued', 'running', 'waiting', 'paused'].includes(a.state))) throw new RoastError('INVALID_REQUEST', '请等主会话和子 agent 空闲后切换模型');
      const next = validateModel(value, effort);
      const adapter = input.providers.get(next);
      delete input.ref.reasoningEffort;
      Object.assign(input.ref, next);
      p.contextCtl.setWindow(adapter.resolveModel?.(next.model)?.contextWindow ?? input.config.providers[next.provider]?.models?.[next.model]?.contextWindow ?? DEFAULT_CONTEXT_WINDOW);
      loop.committer.commit({ type: 'model/change', at: new Date().toISOString(), ...next });
      loop.committer.flush();
      swarm.setRootModel(`${next.provider}:${next.model}`);
      listeners.swarm.forEach((listener) => listener());
    },
    instructions: core.instructions,
    skills: core.ext.skills,
    memory: core.ext.memory,
    ...(input.opened.resumedFrom ? { resumedFrom: input.opened.resumedFrom } : {}),
    broker: core.perms.broker,
    permissions: core.perms.engine,
    ignoredRepoAllow: core.perms.ignoredRepoAllow,
    startupWarnings: startupWarnings(input.cwd, core, input.mcp),
    mcpStatus: () => input.mcp.manager.status(),
    mcpPrompts: () => input.mcp.manager.prompts(),
    mcpPromptContent: (command, args, signal) => input.mcp.manager.promptContent(command, args, signal),
    swarm,
    onAgentEvent(listener) {
      listeners.agent.add(listener);
      return () => listeners.agent.delete(listener);
    },
    onSwarmChange(listener) {
      listeners.swarm.add(listener);
      return () => listeners.swarm.delete(listener);
    },
    listTurns: () => userTurns(loop.committer.state),
    contextStats: () => p.contextCtl.stats(loop.committer.state),
    compact: (focus) => compact(p, focus),
    contextAction(action, ids) {
      if (loop.busy) throw new RoastError('INVALID_REQUEST', '运行中不能调整上下文，请等当前回合结束');
      const text = p.contextCtl.manual(loop.committer.state, action, ids);
      loop.committer.flush();
      return text;
    },
    rewind: (turn) => rewind(p, turn),
    async shutdown() {
      p.lifetime.abort();
      await loop.whenIdle();
      await swarm.whenIdle();
      // 没有改动的 worktree 删除；有未合并改动的保留在 ROAST_HOME/worktrees 下供检查
      const worktrees = await swarm.cleanupWorktrees();
      await input.mcp.manager.disconnectAll();
      await input.opened.log.close();
      return { worktrees };
    },
  };
}

async function compact(p: ApiParts, focus: string | undefined): Promise<number> {
  if (p.loop.busy) throw new RoastError('INVALID_REQUEST', '运行中不能压缩，请等当前回合结束');
  const saved = await p.contextCtl.compactNow(focus);
  p.loop.committer.flush();
  return saved;
}

async function rewind(p: ApiParts, turn: number) {
  const { loop } = p;
  if (loop.busy) throw new RoastError('INVALID_REQUEST', '运行中不能回退，请先 ESC 中断');
  if (!loop.committer.state.turnStarts[turn]) throw new RoastError('INVALID_REQUEST', `当前历史中没有第 ${turn} 轮`);
  const result = await p.checkpoints.rewind(turn);
  loop.committer.commit({
    type: 'rewind',
    at: new Date().toISOString(),
    toTurn: turn,
    ...(result.checkpoint ? { checkpoint: result.checkpoint } : {}),
    ...(result.backup ? { backup: result.backup } : {}),
    deleted: result.deleted,
  });
  loop.committer.flush();
  return result;
}
