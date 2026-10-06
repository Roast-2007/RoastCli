import type { AgentInfo } from '../../swarm/types.js';
import { treeOrder } from './lines.js';
export interface PlanTask { id: string; title: string; role: string; acceptance: string; dependsOn: string[] }
export interface PlanRow { id: string; title: string; agents: AgentInfo[]; state: string }
export function parsePlan(value: string | undefined): PlanTask[] | null {
  try {
    const parsed: unknown = JSON.parse(value ?? '');
    if (!parsed || typeof parsed !== 'object' || !('tasks' in parsed) || !Array.isArray(parsed.tasks)) return null;
    const ids = new Set<string>();
    const tasks: PlanTask[] = [];
    for (const task of parsed.tasks) {
      if (!task || typeof task !== 'object' || typeof task.id !== 'string' || !task.id || ids.has(task.id) || typeof task.title !== 'string' || !task.title || typeof task.role !== 'string' || typeof task.acceptance !== 'string' || !Array.isArray(task.dependsOn) || task.dependsOn.some((id: unknown) => typeof id !== 'string')) return null;
      ids.add(task.id); tasks.push(task);
    }
    return tasks;
  } catch { return null; }
}
export function planRows(value: string | undefined, agents: AgentInfo[]): PlanRow[] {
  const children = treeOrder(agents).filter((agent) => agent.parentId);
  const tasks = parsePlan(value);
  if (!tasks) return children.map((agent) => ({ id: agent.taskId ?? agent.id, title: agent.brief, agents: [agent], state: agent.report?.status ?? agent.state }));
  return tasks.map((task) => {
    const assigned = children.filter((agent) => agent.taskId === task.id);
    const latest = assigned.at(-1);
    return { id: task.id, title: task.title, agents: assigned, state: latest?.report?.status ?? latest?.state ?? 'pending' };
  });
}
