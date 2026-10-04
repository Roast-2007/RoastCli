/**
 * 扩展缝：审计与回滚。
 *
 * 地基已就位：session/log-writer.ts 的 JSONL 事件日志记录了全部
 * tool/call 与 tool/result（edit 工具的 metadata 含前后字节数）。
 * 本缝补充"可逆性"：
 * - CheckpointStore 在每次写工具（edit/bash 写操作）执行前对目标文件做快照
 *   （通过工具执行管线的 pre-execute 挂点触发）
 * - rollback 按运行日志倒序回放逆操作：edit → 恢复快照；bash → 仅报告不可自动回滚
 * - 审计视图 = 日志投影 + checkpoint 索引
 */

export interface Checkpoint {
  id: string;
  runId: string;
  at: string;
  /** 触发来源（tool callId） */
  callId: string;
  /** 被快照的文件绝对路径 */
  path: string;
  /** 快照文件位置（checkpoint 目录内） */
  snapshotPath: string;
  /** 文件在快照时是否存在（不存在的文件回滚 = 删除） */
  existed: boolean;
}

export interface CheckpointStore {
  /** 在写操作前调用；文件不存在时记录 existed:false */
  snapshot(path: string, callId: string): Promise<Checkpoint>;
  list(runId?: string): Promise<Checkpoint[]>;
  /** 把文件恢复到 checkpoint 状态（含"原本不存在则删除"） */
  restore(checkpointId: string): Promise<void>;
}
