export { defineTool, emptyHooks, MapToolServices, textResult, toolErrorResult, toolSchemaOf } from './tool.js';
export type {
  PostExecuteHook,
  PreExecuteDecision,
  PreExecuteHook,
  ToolContext,
  ToolDefinition,
  ToolExecutorHooks,
  ToolProgress,
  ToolResult,
  ToolServices,
} from './tool.js';
export { zodToJsonSchema } from './json-schema.js';
export { ToolRegistry } from './registry.js';
export type { ToolRegistryFilter } from './registry.js';
export { executeTool } from './executor.js';
export { FileStateStore, FS_STATE_KEY, getFileStateStore } from './fs-state.js';
export type { FileState } from './fs-state.js';
export { bashTool } from './bash/index.js';
export { bashOutputTool, killShellTool } from './bash/job-tools.js';
export { readTool } from './read/index.js';
export { editTool } from './edit/index.js';
export { multiEditTool } from './multi-edit/index.js';
export { writeTool } from './write/index.js';
export { globTool } from './search/glob.js';
export { grepTool } from './search/grep.js';
export { lsTool } from './search/ls.js';
export { webFetchTool } from './web/fetch.js';
export { askUserTool, exitPlanModeTool, todoWriteTool, BROKER_KEY, PERMISSIONS_KEY, TODOS_KEY } from './interact/index.js';
export type { TodoItem } from './interact/index.js';

import { ToolRegistry } from './registry.js';
import type { ToolDefinition } from './tool.js';
import { bashTool } from './bash/index.js';
import { bashOutputTool, killShellTool } from './bash/job-tools.js';
import { readTool } from './read/index.js';
import { editTool } from './edit/index.js';
import { multiEditTool } from './multi-edit/index.js';
import { writeTool } from './write/index.js';
import { globTool } from './search/glob.js';
import { grepTool } from './search/grep.js';
import { lsTool } from './search/ls.js';
import { webFetchTool } from './web/fetch.js';
import { askUserTool, exitPlanModeTool, todoWriteTool } from './interact/index.js';
import { recallTool } from '../context/recall-tool.js';
import { SWARM_TOOLS } from '../swarm/tools.js';
import { skillTool } from '../ext/skills/tool.js';
import { memoryTool } from '../ext/memory/local.js';
import { searchCodeTool } from '../ext/rag/tool.js';

/** 内置工具全集（顺序固定：工具列表整场会话不变，利于前缀缓存；plan 模式等限制由权限引擎实现） */
export const BUILTIN_TOOLS: readonly ToolDefinition[] = [
  readTool,
  globTool,
  grepTool,
  lsTool,
  searchCodeTool,
  editTool,
  multiEditTool,
  writeTool,
  bashTool,
  bashOutputTool,
  killShellTool,
  webFetchTool,
  todoWriteTool,
  askUserTool,
  exitPlanModeTool,
  skillTool,
  memoryTool,
  recallTool,
  ...SWARM_TOOLS,
] as readonly ToolDefinition[];

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of BUILTIN_TOOLS) registry.register(tool);
  return registry;
}
