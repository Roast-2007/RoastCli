import { truncateDisplay, wrapDisplay } from '../../core/text-width.js';
import { terminalText } from '../../core/terminal-text.js';
import type { AgentInfo } from '../../swarm/types.js';
import type { UiStoreState } from '../store/store.js';
import { STATE_ICON } from './ColonyPane.js';
import type { Target } from './hitmap.js';
import type { Line } from './lines.js';
import { parsePlan, planRows, type PlanRow } from './plan.js';
import { missionChildren } from './phase.js';

function stats(row: PlanRow, ui: UiStoreState): string {
  const results = row.agents.flatMap((a) => (ui.meta.diffs?.[a.id]?.result ? [ui.meta.diffs[a.id]!.result!] : []));
  return results.length ? ` +${results.reduce((n, r) => n + r.added, 0)} −${results.reduce((n, r) => n + r.removed, 0)}` : '';
}
function icon(state: string, ascii: boolean): string {
  return ascii ? (state === 'done' ? '+' : '*') : (STATE_ICON[state] ?? '·');
}
function wrapped(text: string, width: number, target: Target, tone: Line['tone'] = 'text', limit = Infinity, ascii = false): Line[] {
  const rows = wrapDisplay(terminalText(text), Math.max(1, width - 2));
  const shown = rows.slice(0, limit);
  const hint = ascii ? '... Enter 展开' : '… Enter 展开';
  if (rows.length > limit) shown[shown.length - 1] = truncateDisplay(shown.at(-1)! + hint, Math.max(1, width - 2), hint);
  return shown.map((text, i) => ({
    text: `  ${text}`,
    target,
    tone,
    ...(rows.length > limit && i === shown.length - 1 && text.endsWith(hint) ? { mutedSuffix: hint } : {}),
  }));
}

/** Queen 与指定成员的待办；详情传入全部成员，文本不截断。 */
export function todoLines(ui: UiStoreState, ids: string[], width: number, ascii: boolean, full = false): Line[] {
  return [...new Set(['main', ...ids])].flatMap((id) => {
    const todos = ui.agents[id]?.todos ?? [];
    if (!todos.length) return [];
    const target: Target = { kind: 'todo-row', agentId: id };
    const lines: Line[] = [
      { text: '', tone: 'text', target },
      {
        text: `待办 · ${id === 'main' ? 'Queen' : id}  ${todos.filter((t) => t.status === 'completed').length}/${todos.length}`,
        tone: 'accent',
        target,
      },
    ];
    for (const todo of todos) {
      const symbol = ascii
        ? { pending: '[ ]', in_progress: '[~]', completed: '[x]' }[todo.status]
        : { pending: '☐', in_progress: '◐', completed: '☑' }[todo.status];
      const text = `${symbol} ${todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content}`;
      lines.push(...wrapped(text, width, target, todo.status === 'completed' ? 'muted' : 'text', full ? Infinity : 2, ascii));
    }
    return lines;
  });
}

export function planPageLines(value: string | undefined, ui: UiStoreState, selected: string, width: number, ascii: boolean): Line[] {
  const rows = planRows(value, missionChildren(ui.agents.main!, ui.meta.swarm));
  const lines = rows.flatMap((row): Line[] => {
    const target: Target = { kind: 'plan-row', taskId: row.id, agentId: row.agents.at(-1)?.id };
    return [
      {
        text: truncateDisplay(
          `${icon(row.state, ascii)} ${row.id} · ${row.agents.map((a) => a.id).join(',') || '—'} · ${row.state}${stats(row, ui)}`,
          width,
        ),
        target,
        tone: row.state === 'done' ? 'ok' : 'text',
      },
      ...wrapped(row.title, width, target, 'text', width < 80 ? 3 : Infinity, ascii),
    ];
  });
  return [...lines, ...todoLines(ui, [selected], width, ascii)];
}

function taskBlock(row: PlanRow, tasks: ReturnType<typeof parsePlan>, ui: UiStoreState, width: number, ascii: boolean): Line[] {
  const task = tasks?.find((t) => t.id === row.id),
    target: Target = { kind: 'plan-detail', taskId: row.id };
  const role = task?.role || row.agents.at(-1)?.role || '—';
  const lines = wrapDisplay(
    terminalText(
      `${icon(row.state, ascii)} ${row.id} · ${role} · ${row.state} · ${row.agents.map((a) => a.id).join(',') || '—'}${stats(row, ui)}`,
    ),
    width,
  ).map((text): Line => ({ text, tone: 'accent', target }));
  lines.push(...wrapped(row.title, width, target));
  if (task?.acceptance) lines.push(...wrapped(`验收：${task.acceptance}`, width, target));
  if (task?.dependsOn.length) lines.push(...wrapped(`依赖：${task.dependsOn.join(', ')}`, width, target));
  for (const member of row.agents) {
    const memberTarget: Target = { kind: 'plan-member', agentId: member.id };
    lines.push(
      ...wrapDisplay(terminalText(`${member.id} ${member.role} ${member.state}`), width).map(
        (text): Line => ({ text, target: memberTarget, tone: 'tool' }),
      ),
    );
    if (member.report?.summary) lines.push(...wrapped(member.report.summary.split('\n').slice(0, 3).join('\n'), width, target, 'muted'));
  }
  lines.push({ text: '', tone: 'text', target });
  return lines;
}

export function planDetailLines(value: string | undefined, ui: UiStoreState, width: number, ascii: boolean): Line[] {
  const tasks = parsePlan(value),
    children: AgentInfo[] = missionChildren(ui.agents.main!, ui.meta.swarm);
  const blocks = planRows(value, children).flatMap((row) => taskBlock(row, tasks, ui, width, ascii));
  const todos = todoLines(ui, Object.keys(ui.agents), width, ascii, true);
  return [...blocks, ...todos].map((line) => ({
    ...line,
    target:
      line.target?.kind === 'todo-row'
        ? { kind: 'plan-detail', todoAgentId: line.target.agentId }
        : (line.target ?? { kind: 'plan-detail' }),
  }));
}
