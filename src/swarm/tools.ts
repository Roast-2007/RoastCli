/**
 * 蜂群工具（全员可见，保证工具列表恒定）：spawn_agent / send_message / await_agents / report / merge_worktree /
 * board_write / board_read / board_list / board_watch / agents_status / task。
 * 依赖 ToolServices 中的 SWARM_KEY → { supervisor, agentId }（每个 agent 各自一份）。
 */
import { z } from 'zod';
import { isMutating } from '../ext/audit/checkpoints.js';
import { defineTool, textResult, toolErrorResult, type PreExecuteHook, type ToolContext, type ToolResult } from '../tools/tool.js';
import type { Supervisor, WaitResult } from './supervisor.js';
import { parseAddress, READ_ONLY_ROLES, type AgentRole, type Report } from './types.js';
import { ISOLATION_MODES } from './isolation.js';

export const SWARM_KEY = 'swarm';

export interface SwarmAccess {
  supervisor: Supervisor;
  agentId: string;
}

function access(ctx: ToolContext): SwarmAccess | null {
  return ctx.services.get<SwarmAccess>(SWARM_KEY) ?? null;
}

const NO_SWARM = '当前会话未启用蜂群';
const SPAWNABLE = ['lead', 'worker', 'scout', 'critic', 'judge'] as const;

function formatReports(r: WaitResult): string {
  const lines = r.reports.map((x) => `[${x.agentId}] ${x.status}：${x.summary}${x.refs.length ? `\n  引用：${x.refs.join(', ')}` : ''}`);
  const head =
    r.reason === 'done'
      ? '等待完成'
      : r.reason === 'message'
        ? '收到需要处理的消息，提前返回（见下一条 inbox）'
        : r.reason === 'timeout'
          ? '等待超时'
          : '等待被中断';
  const pending = r.pending.length ? `\n仍在进行：${r.pending.join(', ')}` : '';
  return `${head}${pending}\n${lines.join('\n') || '（暂无报告）'}`;
}

export const spawnAgentTool = defineTool({
  name: 'spawn_agent',
  description: '派生一个子 agent 并行处理子任务。role：lead / worker / scout / critic / judge。返回 agent id；完成后它会 report。',
  parameters: z.object({
    role: z.enum(SPAWNABLE),
    task: z.string().min(1).describe('清晰、自包含的任务描述（子 agent 看不到你的对话历史）'),
    refs: z.array(z.string()).optional().describe('参考资料：黑板键、文件路径或 ctx 句柄'),
    isolation: z
      .enum(ISOLATION_MODES)
      .optional()
      .describe('工作区隔离：auto（默认：worker / lead 在 git 仓库中用独立 worktree）/ worktree / shared（与你共享工作区）'),
  }),
  isReadOnly: false,
  isConcurrencySafe: false,
  permission: { kind: 'interact' },
  async execute(args, ctx): Promise<ToolResult> {
    const s = access(ctx);
    if (!s) return toolErrorResult('spawn_agent', NO_SWARM);
    const r = s.supervisor.spawn(s.agentId, {
      role: args.role,
      task: args.task,
      ...(args.refs ? { refs: args.refs } : {}),
      ...(args.isolation ? { isolation: args.isolation } : {}),
    });
    if (!r.ok) return toolErrorResult('spawn_agent', r.reason);
    return textResult(`已派生 ${r.id}（${args.role}）。它完成后会 report；可用 await_agents 等待，或继续做其他事。`, { agentId: r.id });
  },
});

export const sendMessageTool = defineTool({
  name: 'send_message',
  description: '给其他 agent 发消息。to：parent / children / siblings / <agent id> / role:<角色> / broadcast（仅主会话）。正文要短，大内容先写黑板再给键名。',
  parameters: z.object({
    to: z.string(),
    kind: z.enum(['question', 'answer', 'info', 'alert', 'steer', 'task']),
    subject: z.string().min(1),
    body: z.string(),
    refs: z.array(z.string()).optional(),
    reply_to: z.string().optional().describe('回复的消息 id'),
  }),
  isReadOnly: false,
  isConcurrencySafe: false,
  permission: { kind: 'interact' },
  async execute(args, ctx): Promise<ToolResult> {
    const s = access(ctx);
    if (!s) return toolErrorResult('send_message', NO_SWARM);
    const r = s.supervisor.bus.send(s.agentId, {
      to: parseAddress(args.to),
      kind: args.kind,
      subject: args.subject,
      body: args.body,
      ...(args.refs ? { refs: args.refs } : {}),
      ...(args.reply_to ? { replyTo: args.reply_to } : {}),
    });
    if (!r.ok) return toolErrorResult('send_message', `发送失败：${r.reason}`);
    return textResult(`已发送 ${r.id} → ${r.recipients.join(', ')}`, { id: r.id });
  },
});

export const awaitAgentsTool = defineTool({
  name: 'await_agents',
  description: '等待子 agent 完成并取回报告（等待期间不消耗 token）。mode=all 等全部，any 等任意一个；收到提问等消息会提前返回。',
  parameters: z.object({
    ids: z.array(z.string()).optional().describe('默认等待全部直属子 agent'),
    mode: z.enum(['all', 'any']).default('all'),
    timeout_s: z.number().int().min(1).max(7200).default(1800),
  }),
  isReadOnly: true,
  isConcurrencySafe: false,
  permission: { kind: 'interact' },
  async execute(args, ctx): Promise<ToolResult> {
    const s = access(ctx);
    if (!s) return toolErrorResult('await_agents', NO_SWARM);
    const r = await s.supervisor.wait(s.agentId, args.ids ?? [], args.mode, { timeoutMs: args.timeout_s * 1000, signal: ctx.signal });
    if (r.reason === 'aborted') throw new DOMException('等待被中断', 'AbortError');
    return textResult(formatReports(r), { reason: r.reason, reports: r.reports, pending: r.pending });
  },
});

export const reportTool = defineTool({
  name: 'report',
  description: '向上级提交任务结果（子 agent 完成时必须调用）。大段内容先 board_write，再在 refs 中给出键名。',
  parameters: z.object({
    status: z.enum(['done', 'failed', 'partial', 'changes_requested']),
    summary: z.string().min(1),
    refs: z.array(z.string()).optional(),
  }),
  isReadOnly: false,
  isConcurrencySafe: false,
  permission: { kind: 'interact' },
  async execute(args, ctx): Promise<ToolResult> {
    const s = access(ctx);
    if (!s) return toolErrorResult('report', NO_SWARM);
    const report: Report = { agentId: s.agentId, status: args.status, summary: args.summary, refs: args.refs ?? [] };
    if (!s.supervisor.report(s.agentId, report)) return toolErrorResult('report', '主会话或已提交过报告的 agent 无需再 report');
    return textResult('报告已提交给上级。请用一句话结束本轮，不要再调用工具。');
  },
});

export const mergeWorktreeTool = defineTool({
  name: 'merge_worktree',
  description:
    '把直接下级（在独立 git worktree 中工作的 worker / lead）的改动合并到你的工作区。先 await_agents 等它 report 并审阅结果再合并；' +
    '若你的工作区也改过同样的位置，会返回冲突文件列表且不做任何修改。discard: true 则丢弃它的改动并删除 worktree（如 best-of-N 中落选的方案）。',
  parameters: z.object({
    agentId: z.string().min(1),
    discard: z.boolean().optional().describe('丢弃而不是合并'),
  }),
  isReadOnly: false,
  isConcurrencySafe: false,
  // 合并按编辑处理：触发检查点（可 /rewind）并遵守权限模式；丢弃只删除 worktree，不碰你的工作区
  permission: { kind: 'edit', kindFor: (args) => (args.discard ? 'interact' : undefined), target: (_args, ctx) => ctx.cwd },
  async execute(args, ctx): Promise<ToolResult> {
    const s = access(ctx);
    if (!s) return toolErrorResult('merge_worktree', NO_SWARM);
    const r = await s.supervisor.mergeWorktree(s.agentId, args.agentId, { discard: args.discard === true });
    return r.ok ? textResult(r.text, { merged: args.agentId }) : toolErrorResult('merge_worktree', r.text);
  },
});

export const boardWriteTool = defineTool({
  name: 'board_write',
  description: '写入共享黑板（层级键如 /mission/api/contract）。expect_version 用于防止覆盖他人更新。',
  parameters: z.object({ key: z.string().min(1), value: z.string(), expect_version: z.number().int().min(0).optional() }),
  isReadOnly: false,
  isConcurrencySafe: false,
  permission: { kind: 'interact' },
  async execute(args, ctx): Promise<ToolResult> {
    const s = access(ctx);
    if (!s) return toolErrorResult('board_write', NO_SWARM);
    const r = s.supervisor.board.write(args.key, args.value, { author: s.agentId, ...(args.expect_version !== undefined ? { expect: args.expect_version } : {}) });
    return r.ok ? textResult(`已写入 ${args.key} v${r.version}`) : toolErrorResult('board_write', `版本冲突：当前为 v${r.current}，请先 board_read 再合并后写入`);
  },
});

export const boardReadTool = defineTool({
  name: 'board_read',
  description: '读取黑板上的一个键。',
  parameters: z.object({ key: z.string().min(1) }),
  isReadOnly: true,
  isConcurrencySafe: true,
  permission: { kind: 'interact' },
  async execute(args, ctx): Promise<ToolResult> {
    const s = access(ctx);
    if (!s) return toolErrorResult('board_read', NO_SWARM);
    const e = s.supervisor.board.read(args.key);
    return e ? textResult(`${e.key} v${e.version}（作者 ${e.author}）\n${e.value}`) : toolErrorResult('board_read', `黑板上没有 ${args.key}`);
  },
});

export const boardListTool = defineTool({
  name: 'board_list',
  description: '列出黑板上某前缀下的键（只含元信息）。',
  parameters: z.object({ prefix: z.string().default('/') }),
  isReadOnly: true,
  isConcurrencySafe: true,
  permission: { kind: 'interact' },
  async execute(args, ctx): Promise<ToolResult> {
    const s = access(ctx);
    if (!s) return toolErrorResult('board_list', NO_SWARM);
    const list = s.supervisor.board.list(args.prefix);
    return textResult(list.length ? list.map((m) => `${m.key} v${m.version} ${m.chars} 字（${m.author}）`).join('\n') : '（空）');
  },
});

export const boardWatchTool = defineTool({
  name: 'board_watch',
  description: '订阅黑板前缀：有人更新时你会在 inbox 收到简短通知（不含正文）。',
  parameters: z.object({ prefix: z.string().min(1) }),
  isReadOnly: true,
  isConcurrencySafe: true,
  permission: { kind: 'interact' },
  async execute(args, ctx): Promise<ToolResult> {
    const s = access(ctx);
    if (!s) return toolErrorResult('board_watch', NO_SWARM);
    s.supervisor.board.watch(args.prefix, s.agentId);
    return textResult(`已订阅 ${args.prefix}`);
  },
});

export const agentsStatusTool = defineTool({
  name: 'agents_status',
  description: '查看蜂群中所有 agent 的状态（角色、状态、任务摘要、报告）。',
  parameters: z.object({}),
  isReadOnly: true,
  isConcurrencySafe: true,
  permission: { kind: 'interact' },
  async execute(_args, ctx): Promise<ToolResult> {
    const s = access(ctx);
    if (!s) return toolErrorResult('agents_status', NO_SWARM);
    const lines = s.supervisor.tree().map((a) => `${'  '.repeat(a.depth)}${a.id} [${a.role}] ${a.state}${a.waitingFor ? `（${a.waitingFor}）` : ''}：${a.brief.slice(0, 60)}${a.report ? ` → ${a.report.status}` : ''}`);
    return textResult(lines.join('\n'));
  },
});

export const taskTool = defineTool({
  name: 'task',
  description: '派一个一次性子 agent 完成独立任务并等待其结果（适合并行调研或隔离的小改动）。',
  parameters: z.object({ prompt: z.string().min(1), role: z.enum(['worker', 'scout']).default('worker') }),
  isReadOnly: false,
  isConcurrencySafe: true,
  permission: { kind: 'interact' },
  async execute(args, ctx): Promise<ToolResult> {
    const s = access(ctx);
    if (!s) return toolErrorResult('task', NO_SWARM);
    const spawned = s.supervisor.spawn(s.agentId, { role: args.role, task: args.prompt });
    if (!spawned.ok) return toolErrorResult('task', spawned.reason);
    const r = await s.supervisor.wait(s.agentId, [spawned.id], 'all', { signal: ctx.signal });
    if (r.reason === 'aborted') {
      s.supervisor.cancelSubtree(spawned.id);
      throw new DOMException('等待被中断', 'AbortError');
    }
    const rep = r.reports[0];
    return rep ? textResult(`[${rep.agentId}] ${rep.status}：${rep.summary}`, { report: rep }) : toolErrorResult('task', '子 agent 未返回结果');
  },
});

export const SWARM_TOOLS = [
  spawnAgentTool,
  sendMessageTool,
  awaitAgentsTool,
  reportTool,
  mergeWorktreeTool,
  boardWriteTool,
  boardReadTool,
  boardListTool,
  boardWatchTool,
  agentsStatusTool,
  taskTool,
];

/** Direct edits stay blocked; shell commands use the shared permission engine and user approval. */
export function roleGuardHook(role: AgentRole): PreExecuteHook {
  return (tool, args) =>
    READ_ONLY_ROLES.has(role) && tool.name !== 'bash' && isMutating(tool, args)
      ? { action: 'deny', reason: `你的角色（${role}）是只读的，不能执行会修改工作区的操作（运行测试、类型检查、lint 等验证命令除外）；请把建议写进报告` }
      : { action: 'allow' };
}
