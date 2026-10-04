/**
 * 扩展缝：Plan-and-execute 模式 + 任务列表管理。
 *
 * 设计（借鉴 ccsource 的 plan mode 与 todo 工具）：
 * - AgentLoop 增加 mode: 'direct' | 'plan'，由 PlanModeController 提供
 * - plan 模式：向系统 prompt 注入规划指令 section（order 310），
 *   并把 TaskListStore 暴露给未来的 `todo` 工具；模型先产出计划，
 *   用户确认后切回执行（exitPlanMode 语义）
 * - TaskListStore 是通用任务列表（todo 工具也用它），状态变更通过
 *   回调通知 UI 渲染
 */

export interface TaskItem {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'done' | 'blocked';
  /** 阻塞原因或备注 */
  note?: string;
}

export interface TaskListStore {
  list(): TaskItem[];
  upsert(item: TaskItem): void;
  update(id: string, patch: Partial<Omit<TaskItem, 'id'>>): boolean;
  remove(id: string): boolean;
  clear(): void;
  /** 订阅变更（UI 用）；返回退订函数 */
  subscribe(listener: (items: TaskItem[]) => void): () => void;
}

export type AgentMode = 'direct' | 'plan';

export interface PlanModeController {
  readonly mode: AgentMode;
  readonly tasks: TaskListStore;
  /** 切换模式；进入 plan 时注入 prompt section，退出时移除 */
  setMode(mode: AgentMode): void;
}
