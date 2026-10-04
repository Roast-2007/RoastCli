/**
 * 检查点管理：每个 turn 第一次执行"会改动文件"的工具前，用 ShadowGit 给工作区打快照（落 checkpoint 事件）；
 * rewind(turn) 把文件恢复到该 turn 开始前（取 ≥ turn 的最早检查点：之前没有写操作，状态相同）。
 * 对话的回退由 history reducer 处理 rewind 事件完成。
 */
import { isReadOnlyCommand, parseCommand } from '../../tools/permissions/bash-parse.js';
import type { PreExecuteHook, ToolDefinition } from '../../tools/tool.js';
import type { SessionEvent, SessionEventBody } from '../../session/events.js';
import type { ShadowGit } from './shadow-git.js';

/** 该次调用是否可能改动工作区文件 */
export function isMutating(tool: ToolDefinition, args: unknown): boolean {
  const kind = tool.permission?.kind ?? (tool.isReadOnly ? 'read' : 'execute');
  if (kind === 'edit') return true;
  if (kind !== 'execute') return false;
  if (tool.name !== 'bash') return true;
  const command = (args as { command?: unknown } | null)?.command;
  if (typeof command !== 'string') return true;
  const parsed = parseCommand(command);
  return parsed.hasSubshell || parsed.writesFiles || !parsed.segments.every(isReadOnlyCommand);
}

export interface RewindResult {
  checkpoint?: string;
  backup?: string;
  deleted: string[];
}

export class CheckpointManager {
  private readonly byTurn = new Map<number, string>();
  private commit: ((body: SessionEventBody) => unknown) | null = null;

  constructor(private readonly shadow: ShadowGit) {}

  attach(commit: (body: SessionEventBody) => unknown): void {
    this.commit = commit;
  }

  /** resume：从日志恢复检查点索引（rewind 之后的检查点作废） */
  restoreFromEvents(events: readonly SessionEvent[]): void {
    for (const ev of events) {
      if (ev.type === 'checkpoint') this.byTurn.set(ev.turn, ev.hash);
      else if (ev.type === 'rewind') this.dropFrom(ev.toTurn);
    }
  }

  turns(): number[] {
    return [...this.byTurn.keys()].sort((a, b) => a - b);
  }

  private dropFrom(turn: number): void {
    for (const t of [...this.byTurn.keys()]) if (t >= turn) this.byTurn.delete(t);
  }

  hook(): PreExecuteHook {
    return async (tool, args, ctx) => {
      const turn = ctx.turn;
      if (turn === undefined || this.byTurn.has(turn) || !isMutating(tool, args)) return { action: 'allow' };
      const hash = await this.shadow.snapshot(`turn ${turn}`);
      if (hash) {
        this.byTurn.set(turn, hash);
        this.commit?.({ type: 'checkpoint', at: new Date().toISOString(), turn, hash });
      }
      return { action: 'allow' };
    };
  }

  /** 文件回到 turn 开始前；之后没有任何写操作时无需恢复 */
  async rewind(turn: number): Promise<RewindResult> {
    const target = this.turns().find((t) => t >= turn);
    if (target === undefined) return { deleted: [] };
    const hash = this.byTurn.get(target)!;
    const r = await this.shadow.restore(hash);
    this.dropFrom(turn);
    return { checkpoint: hash, backup: r.backup, deleted: r.deleted };
  }
}
