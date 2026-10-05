/**
 * 会话组装：配置 → providers / tools / system prompt / 日志（新建或恢复）/ 运行时，一次装好。
 * CLI（chat / -p / -c / -r）与测试共用这一个入口 —— 启动时一次组装，不引入插件框架。
 * 具体装配步骤见 session-assembly.ts；这里只做编排与失败清理。
 */
import path from 'node:path';
import {
  isProjectTrusted,
  loadConfig,
  trustState,
  parseModelRef,
  untrustedProviderOverrides,
  type ModelRef,
  type RoastConfig,
  type ReasoningEffort,
} from '../core/config.js';
import type { ModelCatalog } from '../providers/models.js';
import type { AgentRole } from '../swarm/types.js';
import { RoastError } from '../core/errors.js';
import { buildProviderRegistry } from '../providers/registry.js';
import type { ProviderRegistry } from '../providers/adapter.js';
import { createDefaultToolRegistry } from '../tools/index.js';
import type { ExtensionPoints } from '../ext/index.js';
import { renderInstructions, type InstructionFile } from '../ext/instructions.js';
import type { RunLogWriter } from '../session/log-writer.js';
import type { SessionEvent } from '../session/events.js';
import { openRunLog } from '../session/resume.js';
import { readHeader } from '../cli/logs.js';
import { loadRunLog } from '../session/projection.js';
import { registerBaseSections, SystemPromptAssembler } from './system-prompt.js';
import type { AgentRuntime } from './runtime.js';
import type { RewindResult } from '../ext/audit/checkpoints.js';
import type { TurnSummary } from './turns.js';
import type { ContextStats } from '../context/controller.js';
import { setupMcp } from './mcp-setup.js';
import { assembleSession } from './session-assembly.js';
import type { TransportFactory } from '../ext/mcp/manager.js';
import type { McpServerStatus } from '../ext/mcp.js';
import type { McpPromptCommand } from '../ext/mcp/manager.js';
import type { ContentBlock } from '../core/types.js';
import type { SkillRegistry } from '../ext/skills.js';
import type { MemoryProvider } from '../ext/memory.js';
import type { UiEvent } from './ui-events.js';
import type { Supervisor } from '../swarm/supervisor.js';
import { SWARM_SECTION } from '../swarm/roles.js';
import type { InteractionBroker } from '../core/interaction.js';
import type { PermissionEngine, PermissionMode } from '../tools/permissions/engine.js';

export interface Session {
  loop: AgentRuntime;
  log: RunLogWriter;
  config: RoastConfig;
  initialEvents: readonly SessionEvent[];
  providerName: string;
  model: string;
  reasoningEffort?: ReasoningEffort | null;
  switchModel(model: string, effort?: ReasoningEffort | null): void;
  listModels(opts?: { refresh?: boolean; signal?: AbortSignal }): Promise<ModelCatalog>;
  setSwarmModel(role: AgentRole, model: string, effort?: ReasoningEffort | null): void;
  configureSwarmModels?(models: Partial<Record<AgentRole, string>>): void;
  /** 主会话费用估算；任一已用模型缺少定价时返回 null。 */
  cost(): number | null;
  costBreakdown?(): import('../core/usage-cost.js').UsageBreakdown;
  resume(logPath: string): Promise<Session>;
  instructions: InstructionFile[];
  /** 已加载的技能（/技能名 斜杠命令、命令面板） */
  skills: SkillRegistry;
  /** 项目长期记忆（/memory） */
  memory: MemoryProvider;
  resumedFrom?: { runId: string; messageCount: number };
  /** 权限审批 / 提问的中转站（UI 订阅它显示卡片） */
  broker: InteractionBroker;
  permissions: PermissionEngine;
  /** 因项目未被信任而忽略的仓库 allow 规则 */
  ignoredRepoAllow: string[];
  /** 启动提示（未生效的仓库规则 / 钩子等），显示在横幅中 */
  startupWarnings: string[];
  /** MCP 服务器连接状态（/mcp） */
  mcpStatus(): McpServerStatus[];
  mcpPrompts?(): McpPromptCommand[];
  mcpPromptContent?(command: string, args: string, signal?: AbortSignal): Promise<ContentBlock[]>;
  /** 上下文占用统计（/context） */
  contextStats(): ContextStats;
  /** /context pin | unpin | drop：手动调整上下文（运行中调用会抛错），返回说明 */
  contextAction(action: 'pin' | 'unpin' | 'drop', ids: string[]): string;
  /** 立即压缩上下文（/compact），返回约节省的 tokens */
  compact(focus?: string): Promise<number>;
  /** Hive 蜂群中枢（主会话即 root / Queen） */
  swarm: Supervisor;
  /** 订阅子 agent 的运行时事件（Mission Control / agents 面板） */
  onAgentEvent(listener: (agentId: string, ev: UiEvent) => void): () => void;
  /** 订阅 agent 树变化 */
  onSwarmChange(listener: () => void): () => void;
  /** 当前历史中的用户 turn（/rewind 列表） */
  listTurns(): TurnSummary[];
  /** 回退到第 turn 轮开始前：恢复文件（影子 git 检查点）并回退对话；运行中调用会抛错 */
  rewind(turn: number): Promise<RewindResult>;
  /** 中断进行中的 turn、等待运行时空闲后关闭日志（退出前调用，保证日志配对完整） */
  shutdown(): Promise<{ worktrees: string[] }>;
}

export interface CreateSessionOptions {
  cwd?: string;
  /** 覆盖 config.default（"provider:model"） */
  modelRef?: string;
  roleModels?: Partial<Record<AgentRole, string>>;
  extensions?: ExtensionPoints;
  /** 从该运行日志恢复（-c / -r） */
  resumeLogPath?: string;
  /** 权限模式（--permission-mode），优先于恢复的模式与配置默认值 */
  permissionMode?: PermissionMode;
  /** 注入：直接使用该配置（测试 / 嵌入场景，跳过配置文件加载） */
  config?: RoastConfig;
  /** 注入：直接使用该 provider 注册表（测试用脚本化 provider） */
  providers?: ProviderRegistry;
  /** 注入：MCP 传输工厂（测试用进程内服务器） */
  mcpTransport?: TransportFactory;
}

export function logsRootOf(config: RoastConfig, cwd: string): string {
  return path.isAbsolute(config.logsDir) ? config.logsDir : path.join(cwd, config.logsDir);
}

/** 模型选择：显式 -m > 恢复会话原模型（provider 仍在配置中）> config.default */
function chooseModel(config: RoastConfig, explicit: string | undefined, resumeLogPath: string | undefined): ModelRef {
  if (explicit) return parseModelRef(explicit);
  if (resumeLogPath) {
    const changed = loadRunLog(resumeLogPath).events.filter((event) => event.type === 'model/change').at(-1);
    if (changed?.type === 'model/change' && config.providers[changed.provider]) return { provider: changed.provider, model: changed.model, ...(changed.reasoningEffort !== undefined ? { reasoningEffort: changed.reasoningEffort } : {}) };
    const h = readHeader(resumeLogPath);
    const provider = typeof h?.['provider'] === 'string' ? h['provider'] : undefined;
    const model = typeof h?.['model'] === 'string' ? h['model'] : undefined;
    if (provider && model && config.providers[provider]) return { provider, model };
  }
  return parseModelRef(config.default);
}

function buildSystemPrompt(cwd: string, instructions: InstructionFile[]): SystemPromptAssembler {
  const systemPrompt = new SystemPromptAssembler();
  const shell = process.platform === 'win32' ? 'git-bash (via C:\\Program Files\\Git\\bin\\bash.exe)' : '/bin/bash';
  registerBaseSections(systemPrompt, {
    cwd,
    platform: `${process.platform} ${process.arch}`,
    shell,
    date: new Date().toISOString().slice(0, 10),
  });
  const text = renderInstructions(instructions);
  if (text) systemPrompt.register({ name: 'instructions', order: 150, text });
  systemPrompt.register({ name: 'swarm', order: 300, text: SWARM_SECTION });
  return systemPrompt;
}

function requireConfig(cwd: string, injected: RoastConfig | undefined): RoastConfig {
  const config = injected ?? loadConfig(cwd);
  if (config) return config;
  throw new RoastError(
    'CONFIG',
    `未找到配置文件。运行 roast config 使用配置向导，或 roast init 生成配置，或创建 ~/.roast/config.json / ${cwd}/.roast/config.json（参考 roastcli.config.example.json），或设置 ROASTCLI_CONFIG 环境变量`,
  );
}

export async function createSession(opts: CreateSessionOptions = {}): Promise<Session> {
  const cwd = opts.cwd ?? process.cwd();
  const baseConfig = requireConfig(cwd, opts.config);
  const config = { ...baseConfig, swarm: { ...baseConfig.swarm, models: { ...baseConfig.swarm.models, ...opts.roleModels } } };
  const queen = config.swarm.models.queen;
  const ref = chooseModel(config, opts.modelRef ?? (queen && queen !== 'inherit' ? queen : undefined), opts.resumeLogPath);
  assertProviderTrusted(cwd, ref.provider);
  // 子 agent 可按角色路由到其他 provider：同样要求其连接信息可信（否则仓库可借 swarm.models 把密钥发往自己的地址）
  for (const r of Object.values(config.swarm.models ?? {})) if (r !== 'inherit') assertProviderTrusted(cwd, parseModelRef(r).provider);
  if (config.rag?.embeddings) assertProviderTrusted(cwd, config.rag.embeddings.provider);
  const providers = opts.providers ?? buildProviderRegistry(config);
  const opened = await openRunLog({
    logsRoot: logsRootOf(config, cwd),
    info: { cwd, provider: ref.provider, model: ref.model },
    ...(opts.resumeLogPath ? { resumeLogPath: opts.resumeLogPath } : {}),
  });
  const tools = createDefaultToolRegistry();
  const mcp = await setupMcp(cwd, tools, opts.mcpTransport);
  try {
    return await assembleSession({ cwd, config, ref, providers, opened, tools, mcp, opts, buildSystemPrompt, resume: (resumeLogPath) => createSession({ ...opts, cwd, config, providers, modelRef: undefined, resumeLogPath }) });
  } catch (err) {
    // 装配失败：不留下 MCP 子进程与未关闭的日志
    await mcp.manager.disconnectAll();
    await opened.log.close();
    throw err;
  }
}

/** 仓库内配置改动了所用 provider 的连接信息，且项目未被信任 → 拒绝启动（防 API key 外泄） */
function assertProviderTrusted(cwd: string, provider: string): void {
  if (!untrustedProviderOverrides(cwd).includes(provider) || isProjectTrusted(cwd)) return;
  const changed = trustState(cwd) === 'changed' ? '该项目曾被信任，但此后相关配置已被修改。' : '';
  throw new RoastError(
    'UNTRUSTED_CONFIG',
    `${changed}项目内的配置文件（.roast/config.json 或 roastcli.config.json）设置了 provider "${provider}" 的连接信息（driver/baseURL/apiKeyEnv/apiKeyRef/headers）。` +
      '为防止 API 密钥被发往不可信的地址，请确认这些配置无误后运行 `roast trust` 信任此项目。',
  );
}
