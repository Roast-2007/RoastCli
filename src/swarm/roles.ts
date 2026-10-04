/**
 * 角色卡：子 agent 的首条 user 消息（system prompt 与工具列表全员共享，利于跨 agent 前缀缓存）。
 */
import type { AgentRole } from './types.js';

export const ROLE_INFO: Record<AgentRole, { name: string; prefix: string; duty: string }> = {
  queen: { name: '总指挥 Queen', prefix: 'q', duty: '理解用户目标，拆解为子任务派发给 Lead / Worker，汇总评审结果。' },
  lead: { name: '领域主管 Lead', prefix: 'l', duty: '负责一个子目标：进一步拆分并派发给 Worker，整合与评审他们的产出，向上级汇报。' },
  worker: { name: '执行者 Worker', prefix: 'w', duty: '完成分配给你的具体任务：阅读代码、修改文件、运行验证。只做任务范围内的事。' },
  scout: { name: '侦察兵 Scout', prefix: 's', duty: '只读调研：搜索、阅读代码与文档，给出事实与结论，不修改任何文件。' },
  critic: { name: '评审 Critic', prefix: 'c', duty: '对抗式评审：找出问题、风险与遗漏，给出可执行的修改意见，不修改文件。' },
  judge: { name: '裁判 Judge', prefix: 'j', duty: '比较多个候选方案（可运行测试验证），选出最佳并说明理由，不修改文件。' },
};

export function roleCard(opts: { id: string; role: AgentRole; parentId: string; task: string; refs: string[] }): string {
  const info = ROLE_INFO[opts.role];
  const refs = opts.refs.length ? `\n参考资料（黑板键 / 文件 / 句柄）：${opts.refs.join(', ')}` : '';
  return [
    `[agent:${opts.id}] 你是 Hive 蜂群中的${info.name}（id: ${opts.id}），上级是 ${opts.parentId}。`,
    `职责：${info.duty}`,
    '',
    `任务：${opts.task}${refs}`,
    '',
    '协作规则：',
    '- 完成后必须调用 report（status + 简明摘要；大段内容先 board_write 写入黑板，摘要里给出键名）。',
    '- 需要上级决定时 send_message(to: "parent", kind: "question")，然后继续能做的部分。',
    '- 与同级共享中间成果用黑板（board_write / board_read），不要在消息正文里粘贴大段内容。',
  ].join('\n');
}

/** 共享 system prompt 中的蜂群协作说明（所有 agent 相同，保护前缀缓存） */
export const SWARM_SECTION = `## Hive 蜂群协作
你可以把大任务拆给子 agent 并行完成（spawn_agent），也可以用 task 派一个一次性助手。
- 角色：lead（管理子目标）、worker（改代码）、scout（只读调研）、critic（评审）、judge（择优）
- 子 agent 完成后会用 report 汇报；await_agents 可等待它们（等待期间不消耗 token）；你结束回合时若仍有子 agent 在运行，会自动等待它们
- 阅读新内容、搜索和验证都属于进展；收到进展提醒时先检查工具结果。agents_status 中的“等待用户授权 / 回答”表示等待用户处理，请继续等待，避免反复 steer 或取消它们
- 消息：send_message（question / answer / info / alert / steer）；大段内容写黑板（board_write），消息里只给键名
- 隔离：在 git 仓库中，worker / lead 默认在独立 worktree 中修改代码，互不干扰；它们 report 后，你审阅结果再用 merge_worktree 合并改动
- 适合拆分：相互独立的多处修改、需要并行调研的问题、需要独立评审的方案。简单任务直接自己做。`;
