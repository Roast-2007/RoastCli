/**
 * 交互类工具：todo_write（任务清单）、ask_user（向用户提问）、exit_plan_mode（提交计划请求批准）。
 * 依赖 ToolServices 中的 InteractionBroker（'broker'）与 PermissionEngine（'permissions'）。
 */
import { z } from 'zod';
import type { InteractionBroker } from '../../core/interaction.js';
import type { PermissionEngine } from '../permissions/engine.js';
import { defineTool, textResult, toolErrorResult, type ToolResult, type ToolServices } from '../tool.js';

export const BROKER_KEY = 'broker';
export const PERMISSIONS_KEY = 'permissions';
export const TODOS_KEY = 'todos';

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  /** 进行中时的动名词描述（UI 用），如"正在运行测试" */
  activeForm?: string;
}

const STATUS_ICON: Record<TodoItem['status'], string> = { pending: '☐', in_progress: '◐', completed: '☑' };

export function renderTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return '（任务清单为空）';
  return todos.map((t) => `${STATUS_ICON[t.status]} ${t.content}`).join('\n');
}

export const todoWriteTool = defineTool({
  name: 'todo_write',
  description:
    '维护当前任务的待办清单（整体替换）。适用于 3 步以上的多步骤任务：开始前列出步骤，执行中及时更新状态。' +
    '同一时间只应有一个 in_progress；完成一项立刻标记 completed，不要攒着批量更新。',
  parameters: z.object({
    todos: z
      .array(
        z.object({
          content: z.string().min(1).describe('任务内容（祈使句）'),
          status: z.enum(['pending', 'in_progress', 'completed']),
          activeForm: z.string().optional().describe('进行中时显示的描述，如"正在运行测试"'),
        }),
      )
      .describe('完整的任务清单（会替换旧清单）'),
  }),
  isReadOnly: false,
  isConcurrencySafe: false,
  permission: { kind: 'interact' },

  async execute(args, ctx): Promise<ToolResult> {
    const todos: TodoItem[] = args.todos.map((t) => ({ ...t }));
    ctx.services.set(TODOS_KEY, todos);
    const inProgress = todos.filter((t) => t.status === 'in_progress').length;
    const warn = inProgress > 1 ? `\n注意：同时有 ${inProgress} 项 in_progress，建议一次只推进一项。` : '';
    const done = todos.filter((t) => t.status === 'completed').length;
    return textResult(`任务清单已更新（${done}/${todos.length} 完成）：\n${renderTodos(todos)}${warn}`, { todos });
  },
});

function brokerOf(services: ToolServices): InteractionBroker | undefined {
  return services.get<InteractionBroker>(BROKER_KEY);
}

export const askUserTool = defineTool({
  name: 'ask_user',
  description:
    '向用户提一个需要其决定的问题（需求不明确、多个方案需取舍时）。可给出选项供选择；用户也可自由回答。' +
    '能通过阅读代码自行确认的事情不要问。',
  parameters: z.object({
    question: z.string().min(1).describe('问题'),
    options: z.array(z.string()).max(6).optional().describe('候选答案（可选）'),
  }),
  isReadOnly: true,
  isConcurrencySafe: false,
  permission: { kind: 'interact' },

  async execute(args, ctx): Promise<ToolResult> {
    const broker = brokerOf(ctx.services);
    const res = broker
      ? await broker.request(
          { kind: 'question', agentId: ctx.agentId ?? 'main', question: args.question, ...(args.options ? { options: args.options } : {}) },
          ctx.signal,
        )
      : ({ kind: 'unavailable' } as const);
    if (res.kind !== 'question') {
      return toolErrorResult('ask_user', '当前为非交互模式，无法询问用户。请基于合理假设继续，并在回复中说明你的假设。');
    }
    return textResult(`用户回答：${res.answer}`, { answer: res.answer });
  },
});

const APPROVE = '批准，开始执行';
const REVISE = '继续完善计划';

export const exitPlanModeTool = defineTool({
  name: 'exit_plan_mode',
  description:
    'plan 模式下完成调研与规划后调用：提交实施计划（markdown）请用户批准。批准后退出 plan 模式开始执行；' +
    '否则根据用户反馈继续完善计划。',
  parameters: z.object({ plan: z.string().min(1).describe('实施计划（markdown）') }),
  isReadOnly: true,
  isConcurrencySafe: false,
  permission: { kind: 'interact' },

  async execute(args, ctx): Promise<ToolResult> {
    const engine = ctx.services.get<PermissionEngine>(PERMISSIONS_KEY);
    if (engine && engine.mode !== 'plan') return toolErrorResult('exit_plan_mode', '当前不在 plan 模式，直接执行即可。');
    const broker = brokerOf(ctx.services);
    const res = broker
      ? await broker.request(
          { kind: 'question', agentId: ctx.agentId ?? 'main', question: `请审阅计划：\n\n${args.plan}`, options: [APPROVE, REVISE] },
          ctx.signal,
        )
      : ({ kind: 'unavailable' } as const);
    if (res.kind !== 'question') return toolErrorResult('exit_plan_mode', '非交互模式下无法请求批准，计划未执行。');
    if (res.answer === APPROVE) {
      engine?.setMode('default');
      return textResult('用户已批准计划，已退出 plan 模式。现在开始按计划执行。', { approved: true });
    }
    return textResult(`用户未批准，反馈：${res.answer}。请据此完善计划后再次提交。`, { approved: false, feedback: res.answer });
  },
});
