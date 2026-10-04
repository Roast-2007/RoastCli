/**
 * 扩展缝总装：ExtensionPoints 是启动时一次性组装的容器，
 * agent loop / 工具层 / UI 从这里读取可选扩展。所有字段可选 ——
 * 未安装对应扩展时行为与本期一致（空实现 / 直通）。
 *
 * 各扩展的设计约定见同目录对应文件。
 */
import type { SkillRegistry } from './skills.js';
import type { McpClientManager } from './mcp.js';
import type { MemoryProvider } from './memory.js';
import type { PlanModeController } from './plan.js';
import type { RetrievalProvider } from './rag.js';
import type { CheckpointStore } from './audit.js';
import type { InputGuard, OutputGuard } from './guard.js';
import type { PromptStore } from './prompts.js';

export interface ExtensionPoints {
  skills?: SkillRegistry;
  mcp?: McpClientManager;
  memory?: MemoryProvider;
  plan?: PlanModeController;
  rag?: RetrievalProvider;
  audit?: CheckpointStore;
  inputGuard?: InputGuard;
  outputGuard?: OutputGuard;
  prompts?: PromptStore;
}

export function emptyExtensions(): ExtensionPoints {
  return {};
}

export type { SkillRegistry, SkillMeta } from './skills.js';
export type { McpClientManager, McpServerConfig } from './mcp.js';
export type { MemoryProvider, MemoryFact } from './memory.js';
export type { PlanModeController, TaskItem, TaskListStore } from './plan.js';
export type { RetrievalProvider } from './rag.js';
export type { CheckpointStore, Checkpoint } from './audit.js';
export type { InputGuard, OutputGuard, GuardVerdict } from './guard.js';
export type { PromptStore } from './prompts.js';
