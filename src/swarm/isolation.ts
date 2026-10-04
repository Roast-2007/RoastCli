/**
 * 子 agent 的工作区隔离策略：
 * - auto（默认）：写入型角色（worker / lead）在 git 仓库中使用独立 worktree；只读角色与非 git 项目共享父 agent 的工作区（写入靠租约协调）
 * - worktree：强制尝试 worktree（不可用时回退共享）
 * - shared：共享父 agent 的工作区
 * worktree 中的 agent 不得按绝对路径修改原仓库：守卫钩子拒绝并给出 worktree 内的对应路径。
 */
import path from 'node:path';
import { isPathInside } from '../core/paths.js';
import type { PreExecuteHook } from '../tools/tool.js';
import type { AgentRole } from './types.js';
import type { MergeResult, Worktree } from './worktree.js';
import { permissionRequestOf } from '../tools/permissions/hook.js';

export type IsolationMode = 'auto' | 'worktree' | 'shared';

export const ISOLATION_MODES = ['auto', 'worktree', 'shared'] as const;

const WRITER_ROLES: ReadonlySet<AgentRole> = new Set(['worker', 'lead']);

/** Supervisor 依赖的 worktree 能力（WorktreeManager 实现；测试可替换） */
export interface WorktreeProvider {
  create(agentId: string, parentCwd: string): Promise<Worktree | null>;
  changedFiles(wt: Worktree): Promise<string[]>;
  merge(wt: Worktree): Promise<MergeResult>;
  remove(wt: Worktree): Promise<void>;
  release?(wt: Worktree): Promise<void>;
}

export function wantsWorktree(mode: IsolationMode, role: AgentRole): boolean {
  return mode === 'worktree' || (mode === 'auto' && WRITER_ROLES.has(role));
}

/** 追加在角色卡后的工作区说明 */
export function worktreeNote(wt: Worktree): string {
  return [
    '',
    '工作区：你在独立的 git worktree 中工作（主仓库的隔离副本，包含派生你时上级工作区的全部改动）。',
    `- 你的工作目录：${wt.cwd}`,
    `- 不要修改原仓库 ${wt.parentRoot} 下的文件；使用相对路径即可`,
    '- node_modules 是独立副本，安装或更新依赖不会修改上级的依赖目录',
    '- shell / 外部执行工具仍能越过目录边界，因此每次执行都需要用户明确批准（yolo 和全局 allow 也不能跳过）；可以用 read / grep 等工具直接调研',
    '- 完成后正常 report；上级会用 merge_worktree 把你的改动合并回去，不需要你提交 git',
  ].join('\n');
}

/** 拒绝 worktree 中的 agent 按绝对路径修改原仓库 */
export function worktreeGuardHook(wt: Worktree): PreExecuteHook {
  return (tool, args, ctx) => {
    const { kind, target } = permissionRequestOf(tool, args, ctx);
    if (kind !== 'edit' || tool.permission?.targetKind === 'label' || !target || isPathInside(wt.root, target)) return { action: 'allow' };
    const mapped = isPathInside(wt.parentRoot, target) ? path.join(wt.root, path.relative(wt.parentRoot, target)) : wt.root;
    return { action: 'deny', reason: `你在隔离的 worktree 中工作，不能直接修改原仓库文件或其他工作区的文件 ${target}。请改为修改 ${mapped}（或使用相对路径）` };
  };
}

export function reportWorktreeNote(agentId: string, wt: Worktree): string {
  return `\n（${agentId} 的改动在独立 worktree：${wt.root}。审阅后用 merge_worktree({ agentId: "${agentId}" }) 合并到你的工作区）`;
}

export function formatMerge(agentId: string, r: MergeResult, wt?: Worktree): string {
  if (r.ok) return r.files.length ? `已把 ${agentId} 的改动合并到你的工作区（${r.files.length} 个文件）：\n${r.files.map((f) => `- ${f}`).join('\n')}` : `${agentId} 没有任何文件改动，无需合并`;
  const files = r.conflicts.map((f) => `- ${f}`).join('\n') || r.detail;
  const where = wt ? `\n它的改动仍保留在 worktree：${wt.root}（基线 ${wt.base.slice(0, 12)}；查看改动：git -C "${wt.root}" status --short 与 git -C "${wt.root}" diff ${wt.base.slice(0, 12)}）` : '';
  const resolver = wt
    ? `\n建议的解决方式：spawn_agent 派一个 worker 作为"合并者"，任务是把 ${agentId} 在上述 worktree 中对这些文件的改动重新应用到它自己的工作区（它的基线已包含你当前的改动，可直接读取 ${agentId} 的 worktree），完成后 merge_worktree 合并这个合并者；最后用 merge_worktree({ agentId: "${agentId}", discard: true }) 丢弃原 worktree。`
    : '';
  return `合并 ${agentId} 失败：以下文件在你的工作区中也被修改过，补丁无法干净应用（未做任何修改）：\n${files}${where}${resolver}`;
}
