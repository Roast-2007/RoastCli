import { Box, Text } from 'ink';
import type { Session } from '../../agent/session.js';
import type { UiStoreState } from '../store/store.js';
import { useTerminal } from '../terminal.js';
import { Pane } from './Pane.js';
import { agentLines, messageLine, type Line } from './lines.js';
import { planRows } from './plan.js';
import { latestMission, missionChildren } from './phase.js';
import { STATE_ICON } from './ColonyPane.js';
import { signalLines } from './SignalsPane.js';
import { missionUsage } from './usage.js';
export const TABS = ['计划', '输出', '改动', '消息', '黑板', '用量'] as const;
export function missionLines(session: Session, ui: UiStoreState, tab: number, selected: string, ascii: boolean): Line[] {
  const main = ui.agents.main!, mission = latestMission(main);
  if (tab === 0) return planRows(session.swarm.board.read('/mission/plan')?.value, missionChildren(main, ui.meta.swarm)).map((row) => ({ text: `${ascii ? row.state === 'done' ? '+' : '*' : STATE_ICON[row.state] ?? '·'} ${row.id} ${row.title} ${row.agents.map((agent) => agent.id).join(',') || '—'} ${row.state}`, tone: row.state === 'done' ? 'ok' : 'text' }));
  if (tab === 1) return agentLines(ui.agents[selected], ascii);
  if (tab === 2) return [{ text: '改动', tone: 'muted' }];
  if (tab === 3) return ui.meta.messages.flatMap((message) => [messageLine(message, ascii), { text: message.body, tone: 'text' as const }]);
  if (tab === 4) return session.swarm.board.list('/').flatMap((entry) => [{ text: `${entry.key} v${entry.version} · ${entry.author}`, tone: 'accent' as const }, { text: session.swarm.board.read(entry.key)?.value ?? '', tone: 'text' as const }]);
  if (tab === 5) return missionUsage(session.costBreakdown?.().entries ?? [], mission?.turn ?? 0, missionChildren(main, ui.meta.swarm).map((agent) => agent.id));
  return signalLines(session, ui);
}
export function MissionPane({ session, ui, tab, selected, height, width, focused, offset, narrow = false, signals = false }: { session: Session; ui: UiStoreState; tab: number; selected: string; height: number; width: number; focused: boolean; offset: number; narrow?: boolean; signals?: boolean }) {
  const { ascii } = useTerminal(), mission = latestMission(ui.agents.main!);
  const lines = missionLines(session, ui, tab, selected, ascii);
  const title = narrow ? '蜂群 计划 输出 改动 信号' : `${(signals ? ['计划', '输出', '改动', '信号', '消息', '黑板', '用量'] : TABS).map((name, index) => `${index + 1}${name}${(signals ? [0, 1, 2, 6, 3, 4, 5][index] : index) === tab ? '*' : ''}`).join(' ')}`;
  const recent = ui.agents.main!.items.filter((item) => item.kind === 'mission').slice(-3);
  return <Pane title={title} lines={lines} height={height} width={width} focused={focused} offset={offset}>
    {tab === 0 && ((!mission && !lines.length) || (session.resumedFrom && !ui.agents.main!.running && !session.swarm.board.read('/mission/plan'))) ? <Box flexGrow={1} justifyContent="center" alignItems="center" flexDirection="column"><Text dimColor>{ascii ? 'HIVE' : '⬡ HIVE'}</Text>{session.resumedFrom && recent.length ? <><Text dimColor>最近的任务</Text>{recent.map((item) => item.kind === 'mission' ? <Text key={item.id} dimColor wrap="truncate-end">{item.goal} · {item.strategy} · {ui.agents.main!.items.find((next) => next.id > item.id && next.kind === 'turn-summary')?.kind === 'turn-summary' ? '已结束' : '未完成'}</Text> : null)}</> : null}</Box> : undefined}
  </Pane>;
}
