import type { AgentInfo } from '../../swarm/types.js';
import { treeOrder } from './lines.js';
export interface PlanTask {
  id: string;
  title: string;
  role: string;
  acceptance: string;
  dependsOn: string[];
}
export interface PlanRow {
  id: string;
  title: string;
  agents: AgentInfo[];
  state: string;
}
export function parsePlan(value: string | undefined): PlanTask[] | null {
  try {
    const parsed: unknown = JSON.parse(value ?? '');
    const raw = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' && 'tasks' in parsed ? parsed.tasks : null;
    if (!Array.isArray(raw)) return null;
    const ids = new Set<string>();
    const tasks: PlanTask[] = [];
    for (const task of raw) {
      if (!task || typeof task !== 'object') continue;
      const id = typeof task.id === 'number' && Number.isFinite(task.id) ? String(task.id) : task.id;
      const title = [task.title, task.task, task.name, task.description].find((v) => typeof v === 'string' && v.trim());
      if (typeof id !== 'string' || !id.trim() || ids.has(id) || !title) continue;
      ids.add(id);
      tasks.push({
        id,
        title,
        role: typeof task.role === 'string' ? task.role : '',
        acceptance: typeof task.acceptance === 'string' ? task.acceptance : '',
        dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn.filter((v: unknown): v is string => typeof v === 'string') : [],
      });
    }
    return tasks.length ? tasks : null;
  } catch {
    return null;
  }
}
export function planRows(value: string | undefined, agents: AgentInfo[]): PlanRow[] {
  const children = treeOrder(agents).filter((agent) => agent.parentId);
  const tasks = parsePlan(value);
  if (!tasks)
    return children.map((agent) => ({
      id: agent.taskId ?? agent.id,
      title: agent.brief,
      agents: [agent],
      state: agent.report?.status ?? agent.state,
    }));
  return tasks.map((task) => {
    const assigned = children.filter((agent) => agent.taskId === task.id);
    const latest = assigned.at(-1);
    return { id: task.id, title: task.title, agents: assigned, state: latest?.report?.status ?? latest?.state ?? 'pending' };
  });
}
