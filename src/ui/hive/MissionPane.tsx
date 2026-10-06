import { Box, Text } from 'ink';
import type { Session } from '../../agent/session.js';
import type { UiStoreState } from '../store/store.js';
import { useTerminal } from '../terminal.js';
import { Pane } from './Pane.js';
import { agentLines, messageLine, type Line } from './lines.js';
import { planRows } from './plan.js';
import { latestMission, missionChildren, missionResult } from './phase.js';
import { STATE_ICON } from './ColonyPane.js';
import { signalLines } from './SignalsPane.js';
import { missionUsage } from './usage.js';
export const TABS = ['计划', '输出', '改动', '消息', '黑板', '用量'] as const;
export function missionLines(session: Session, ui: UiStoreState, tab: number, selected: string, ascii: boolean): Line[] {
  const main = ui.agents.main!, mission = latestMission(main);
  if (tab === 0) return planRows(session.swarm.board.read('/mission/plan')?.value, missionChildren(main, ui.meta.swarm)).map((row) => {
    const stats = row.agents.map((agent) => ui.meta.diffs?.[agent.id]?.result).filter((result) => result !== undefined);
    const summary = stats.length ? ` +${stats.reduce((n, result) => n + result.added, 0)} −${stats.reduce((n, result) => n + result.removed, 0)}` : '';
    return { text: `${ascii ? row.state === 'done' ? '+' : '*' : STATE_ICON[row.state] ?? '·'} ${row.id} ${row.title} ${row.agents.map((agent) => agent.id).join(',') || '—'} ${row.state}${summary}`, tone: row.state === 'done' ? 'ok' : 'text' };
  });
  if (tab === 1) return agentLines(ui.agents[selected], ascii);
  if (tab === 2) {
    const entry = ui.meta.diffs?.[selected];
    if (!entry || entry.loading) return [{ text: '正在读取改动…', tone: 'muted' }];
    if (!entry.result) return [{ text: entry.error ?? '工作区不可用', tone: 'warn' }];
    const result = entry.result;
    return [{ text: `${result.files} 文件 · +${result.added} −${result.removed}`, tone: 'accent' }, ...`${result.stat}\n${result.diff}`.split('\n').map((text): Line => ({ text, tone: text.startsWith('+') ? 'ok' : text.startsWith('-') ? 'error' : 'text' })), ...(result.truncated ? [{ text: '… diff 已截断', tone: 'muted' as const }] : [])];
  }
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
    {tab === 0 && ((!mission && !lines.length) || (session.resumedFrom && !ui.agents.main!.running && !session.swarm.board.read('/mission/plan'))) ? <Box flexGrow={1} justifyContent="center" alignItems="center" flexDirection="column"><Text dimColor>{ascii ? 'HIVE' : '⬡ HIVE'}</Text>{session.resumedFrom && recent.length ? <><Text dimColor>最近的任务</Text>{recent.map((item) => item.kind === 'mission' ? <Text key={item.id} dimColor wrap="truncate-end">{item.goal} · {item.strategy} · {missionResult(ui.agents.main!, item)}</Text> : null)}</> : null}</Box> : undefined}
  </Pane>;
}
