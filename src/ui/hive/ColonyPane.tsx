import type { AgentInfo } from '../../swarm/types.js';
import type { AgentView } from '../store/reducer.js';
import { Pane } from './Pane.js';
import { useTerminal } from '../terminal.js';
import type { Line } from './lines.js';
export const STATE_ICON: Record<string, string> = { queued: '◌', pending: '·', running: '◉', waiting: '◎', paused: 'Ⅱ', done: '✓', failed: '✗', cancelled: '⊘', partial: '◎', changes_requested: '!' };
export function colonyLines(agents: AgentInfo[], views: Readonly<Record<string, AgentView>>, selected: string, ascii: boolean): Line[] {
  return agents.map((agent) => {
    const view = views[agent.id], idle = !agent.parentId && !view?.running;
    const state = idle ? '空闲' : agent.waitingFor ?? agent.report?.status ?? view?.tools.at(-1)?.name ?? agent.state;
    const elapsed = idle ? 0 : Math.floor(((agent.endedAt ?? Date.now()) - (view?.turnStartedAt ?? agent.startedAt)) / 1000);
    return { text: `${agent.id === selected ? '>' : ' '} ${'  '.repeat(agent.depth)}${ascii ? agent.state === 'done' ? '+' : '*' : idle ? '·' : STATE_ICON[agent.state]} ${agent.id === 'main' ? 'queen' : agent.id} [${agent.role}] ${state} ${elapsed}s`, tone: agent.id === selected ? 'accent' : agent.state === 'done' ? 'ok' : agent.state === 'failed' ? 'error' : 'text' };
  });
}
export function ColonyPane({ agents, views, selected, height, width, focused, offset = 0 }: { agents: AgentInfo[]; views: Readonly<Record<string, AgentView>>; selected: string; height: number; width: number; focused: boolean; offset?: number }) {
  const { ascii } = useTerminal();
  return <Pane title="蜂群" lines={colonyLines(agents, views, selected, ascii)} height={height} width={width} focused={focused} offset={offset} fromTop singleLine />;
}
