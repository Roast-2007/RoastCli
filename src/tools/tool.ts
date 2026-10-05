/**
 * 工具抽象：ToolDefinition + defineTool。
 * 设计借鉴 ccsource 的 Tool 接口形状与 deepseek-harness 的 defineTool：
 * - zod schema 定义参数 → 编译成 JSON Schema 给模型
 * - 执行前 zod 校验，失败返回模型可读的 ToolArgsError 结果（不抛）
 * - isReadOnly / isConcurrencySafe 元数据驱动 agent loop 的并发调度
 * - 执行管线留 pre/post-execute 挂点（未来审批、审计、防注入挂同一处）
 */
import { z } from 'zod';
import type { ContentBlock, ToolSchema } from '../core/types.js';
import type { RoastError } from '../core/errors.js';
import type { PermissionKind } from './permissions/rules.js';
import { zodToJsonSchema } from './json-schema.js';
export interface ToolResult {
  content: ContentBlock[];
  isError?: boolean;
  /** 供日志/审计使用的结构化元数据（如 edit 的前后快照引用） */
  metadata?: Record<string, unknown>;
}

export interface ToolServices {
  /** 未来扩展挂载点：memory / rag / audit / skills / fs-state 等，按 key 存取 */
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T): void;
}

/** 最简内存实现（宿主启动时创建一个，测试可直接用） */
export class MapToolServices implements ToolServices {
  private map = new Map<string, unknown>();
  get<T = unknown>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  set<T = unknown>(key: string, value: T): void {
    this.map.set(key, value);
  }
}

/** 工具执行中的进度（如 bash 的实时输出），仅供 UI 展示，不进模型上下文 */
export interface ToolProgress {
  text: string;
  stream?: 'out' | 'err';
}

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  services: ToolServices;
  /** 发起调用的 agent（主会话为 'main'） */
  agentId?: string;
  /** 调用 id（权限审批、进度归属用） */
  callId?: string;
  /** 所在 turn（检查点等按 turn 归档） */
  turn?: number;
  progress?: (p: ToolProgress) => void;
  /** Multi-file tools must authorize every discovered target before writing any file. */
  checkTargets?(paths: string[]): Promise<void>;
}

export interface ToolDefinition<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  /** 给模型看的使用说明 */
  description: string;
  /** zod 参数 schema */
  parameters: S;
  /** 直接给模型的 JSON Schema（MCP 等外部工具：schema 由对方提供，校验也由对方完成；parameters 只做宽松兜底） */
  rawJsonSchema?: Record<string, unknown>;
  /** 只读工具（可与其他只读工具并发执行） */
  isReadOnly: boolean;
  /** 并发安全（通常 = isReadOnly；写工具默认 false） */
  isConcurrencySafe: boolean;
  /** 默认超时（毫秒），可被参数覆盖 */
  timeoutMs?: number;
  /** 模型参数外的自检：返回错误字符串表示拒绝（作为模型可见的失败反馈） */
  validateInput?(args: z.infer<S>, ctx: ToolContext): string | undefined;
  /**
   * 权限元数据：kind 决定默认策略（缺省按 isReadOnly 推断 read / execute），
   * target 给出规则匹配对象（bash：命令；路径类：绝对路径；web_fetch：URL）
   */
  permission?: {
    kind?: PermissionKind;
    /** edit 的 target 通常是路径；长期记忆等工具用 label 展示操作说明。 */
    targetKind?: 'path' | 'label';
    /** 按本次参数决定 kind（如 memory：search 免审批、save 需审批）；返回 undefined 时用 kind */
    kindFor?(args: z.infer<S>): PermissionKind | undefined;
    target?(args: z.infer<S>, ctx: ToolContext): string | undefined;
  };
  execute(args: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
}

/** 编译给模型的 JSON Schema 描述 */
export function toolSchemaOf(def: ToolDefinition): ToolSchema {
  return {
    name: def.name,
    description: def.description,
    parameters: def.rawJsonSchema ?? zodToJsonSchema(def.parameters),
  };
}

export function defineTool<S extends z.ZodTypeAny>(def: ToolDefinition<S>): ToolDefinition<S> {
  return def;
}

// ---------------------------------------------------------------------------
// 执行管线挂点（本期为简单 hook 数组；审批/审计/防注入未来实现同一接口）
// ---------------------------------------------------------------------------

export interface PreExecuteDecision {
  action: 'allow' | 'deny';
  /** deny 时给模型看的理由 */
  reason?: string;
  /** 允许时可选改写后的参数 */
  args?: unknown;
}

export type PreExecuteHook = (tool: ToolDefinition, args: unknown, ctx: ToolContext) => Promise<PreExecuteDecision> | PreExecuteDecision;
export type PostExecuteHook = (tool: ToolDefinition, args: unknown, result: ToolResult, ctx: ToolContext) => Promise<ToolResult> | ToolResult;

export interface ToolExecutorHooks {
  preExecute: PreExecuteHook[];
  postExecute: PostExecuteHook[];
}

export function emptyHooks(): ToolExecutorHooks {
  return { preExecute: [], postExecute: [] };
}

/** 工具执行错误的统一结果包装 */
export function toolErrorResult(name: string, err: RoastError | Error | string): ToolResult {
  const message = typeof err === 'string' ? err : `${err.name}: ${err.message}`;
  return { content: [{ type: 'text', text: message }], isError: true, metadata: { tool: name } };
}

/** 纯文本便捷结果 */
export function textResult(text: string, metadata?: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text }], metadata };
}
