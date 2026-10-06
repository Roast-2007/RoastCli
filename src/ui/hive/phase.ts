import type { AgentInfo } from '../../swarm/types.js';
import type { AgentView, DisplayItem } from '../store/reducer.js';
export type MissionItem = Extract<DisplayItem, { kind: 'mission' }>;
export function latestMission(view: AgentView): MissionItem | undefined { return view.items.slice().reverse().find((item): item is MissionItem => item.kind === 'mission'); }
export function missionChildren(view: AgentView, agents: AgentInfo[]): AgentInfo[] {
  const mission = latestMission(view);
  if (!mission) return agents.filter((agent) => agent.parentId);
  const ids = new Set<string>();
  for (const item of view.items.filter((item) => item.id > mission.id)) {
    const tools = item.kind === 'tool' ? [item.tool] : item.kind === 'tool-group' ? item.tools : [];
    for (const tool of tools) {
      const id = tool.metadata?.['agentId'];
      const report = tool.metadata?.['report'] as { agentId?: string } | undefined;
      if (typeof id === 'string') ids.add(id);
      if (report?.agentId) ids.add(report.agentId);
    }
  }
  const selected = new Set(ids);
  let changed = true;
  while (changed) { changed = false; for (const agent of agents) if (agent.parentId && selected.has(agent.parentId) && !selected.has(agent.id)) { selected.add(agent.id); changed = true; } }
  return agents.filter((agent) => selected.has(agent.id));
}
export function missionPhase(view: AgentView, agents: AgentInfo[]): string {
  const mission = latestMission(view);
  if (!mission) return '空闲';
  const end = view.items.find((item) => item.id > mission.id && item.kind === 'turn-summary');
  if (end?.kind === 'turn-summary') return ({ completed: '完成', aborted: '中断', error: '出错', 'max-steps': '步数上限' } as Record<string, string>)[end.reason] ?? '出错';
  const children = missionChildren(view, agents);
  if (children.some((agent) => ['queued', 'running', 'waiting', 'paused'].includes(agent.state) && !agent.report)) return '执行中';
  return children.length ? '整合中' : '计划中';
}
