/**
 * 角色卡：子 agent 的首条 user 消息（system prompt 与工具列表全员共享，利于跨 agent 前缀缓存）。
 */
import type { AgentRole } from './types.js';
import { ROLE_PROMPT, SWARM_PROMPT } from './prompts.js';
import { substitute } from './strategies.js';

export const ROLE_INFO: Record<AgentRole, { name: string; prefix: string; duty: string }> = {
  queen: { name: '总指挥 Queen', prefix: 'q', duty: '理解用户目标，拆解为子任务派发给 Lead / Worker，汇总评审结果。' },
  lead: {
    name: 'Lead',
    prefix: 'l',
    duty: 'Own this sub-goal: split it, spawn workers with self-contained tasks, review and merge their worktrees into yours, run verification, then report.',
  },
  worker: {
    name: 'Worker',
    prefix: 'w',
    duty: 'Do exactly this task: read the relevant code, make the change, run the narrowest relevant checks. Do not expand the scope.',
  },
  scout: {
    name: 'Scout',
    prefix: 's',
    duty: 'Read-only investigation. Cite path:line for every claim, separate facts from inference, and put long findings on the board (the key given in your task, or /research/{{id}}).',
  },
  critic: {
    name: 'Critic',
    prefix: 'c',
    duty: 'Read-only adversarial review against the acceptance criteria. Run tests and type checks. List findings ranked blocker / major / minor, each with location and a concrete fix. Report status done when there is no blocker or major issue, otherwise changes_requested.',
  },
  judge: {
    name: 'Judge',
    prefix: 'j',
    duty: 'Read-only comparison. Evaluate every candidate against the criteria, running checks in each worktree. Return a scorecard table and the winner with rationale.',
  },
};

export function roleCard(opts: {
  id: string;
  role: AgentRole;
  parentId: string;
  task: string;
  taskId?: string;
  refs: string[];
  maxSteps?: number;
}): string {
  const info = ROLE_INFO[opts.role];
  const prompt = ROLE_PROMPT.replace('{{#taskId}} · task {{taskId}}{{/taskId}}', opts.taskId ? ` · task ${opts.taskId}` : '').replace(
    '{{#refs}}Refs (board keys / files / handles): {{refs}}{{/refs}}',
    opts.refs.length ? `Refs (board keys / files / handles): ${opts.refs.join(', ')}` : '',
  );
  return substitute(prompt, {
    id: opts.id,
    roleName: info.name,
    parentId: opts.parentId,
    task: opts.task,
    maxSteps: String(opts.maxSteps ?? 150),
    duty: substitute(info.duty, { id: opts.id }),
  });
}

/** 共享 system prompt 中的蜂群协作说明（所有 agent 相同，保护前缀缓存） */
export const SWARM_SECTION = SWARM_PROMPT;
