/**
 * 文件租约锁（同一工作区内多 agent 并行写的隔离）：
 * 写类工具执行前为目标文件申请租约；文件被其他存活 agent 持有时拒绝，并告诉模型持有者是谁以便协商。
 * 租约在 agent 结束时整体释放（Supervisor 调用 releaseAll）。
 */
import { canonicalPath } from '../core/paths.js';
import { isMutating } from '../ext/audit/checkpoints.js';
import type { PreExecuteHook } from '../tools/tool.js';

export class LeaseManager {
  private readonly holders = new Map<string, string>();

  constructor(private readonly isAlive: (agentId: string) => boolean = () => true) {}

  /** 申请租约；返回 null 表示成功，否则返回当前持有者 */
  acquire(file: string, agentId: string): string | null {
    const key = canonicalPath(file);
    const holder = this.holders.get(key);
    if (holder && holder !== agentId && this.isAlive(holder)) return holder;
    this.holders.set(key, agentId);
    return null;
  }

  releaseAll(agentId: string): void {
    for (const [k, v] of this.holders) if (v === agentId) this.holders.delete(k);
  }

  heldBy(agentId: string): string[] {
    return [...this.holders].filter(([, v]) => v === agentId).map(([k]) => k);
  }
}

/** 写类工具（permission.kind = edit 且有目标路径）先申请租约 */
export function leaseHook(leases: LeaseManager): PreExecuteHook {
  return (tool, args, ctx) => {
    // 主会话负责协调、生命周期贯穿全程：不参与租约（否则它写过的文件子 agent 永远无法修改）
    if (!ctx.agentId || ctx.agentId === 'main') return { action: 'allow' };
    if (!isMutating(tool, args) || tool.permission?.kind !== 'edit') return { action: 'allow' };
    const target = tool.permission.target?.(args as never, ctx);
    if (!target) return { action: 'allow' };
    const holder = leases.acquire(target, ctx.agentId ?? 'main');
    return holder
      ? { action: 'deny', reason: `文件 ${target} 正被 ${holder} 修改。请用 send_message 与 ${holder} 协商，或先处理其他文件。` }
      : { action: 'allow' };
  };
}
