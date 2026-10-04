/**
 * 扩展缝：长期记忆。
 *
 * 两个实现：
 * - LocalMemoryProvider：本地文件（~/.roast/memory/ 下的 JSONL），零依赖
 * - Mem0Provider：对接 mem0 API / 自托管实例
 * 按配置 memory.driver: 'local' | 'mem0' 切换，loop 与工具不感知差异。
 *
 * 接入方式：
 * - 最近事实在启动时注入稳定的 system section；recall() 由工具主动调用
 * - store() 由 memory 工具调用，保存与删除经过权限检查
 */

export interface MemoryFact {
  id: string;
  content: string;
  tags?: string[];
  createdAt: string;
  /** 来源会话 runId */
  source?: string;
}

export interface MemoryProvider {
  /** 语义/关键词检索相关记忆 */
  recall(query: string, opts?: { limit?: number; signal?: AbortSignal }): Promise<MemoryFact[]>;
  store(fact: Omit<MemoryFact, 'id' | 'createdAt'>, opts?: { signal?: AbortSignal }): Promise<MemoryFact>;
  forget(id: string, opts?: { signal?: AbortSignal }): Promise<boolean>;
  list?(opts?: { limit?: number; signal?: AbortSignal }): Promise<MemoryFact[]>;
}
