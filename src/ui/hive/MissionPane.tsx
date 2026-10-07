import { displayWidth } from '../../core/text-width.js';
import { EMPTY_GUIDES, MissionGuide } from './Guides.js';
import { useTheme } from '../theme.js';
import { paneMetrics } from './Pane.js';
import { missionTabs, tabMemberSuffix } from './tabs.js';
import { Box, Text } from 'ink';
import type { Session } from '../../agent/session.js';
import type { UiStoreState } from '../store/store.js';
import { useTerminal } from '../terminal.js';
import { Pane } from './Pane.js';
import { agentLines, messageLine, type Line } from './lines.js';
import { planRows } from './plan.js';
import { latestMission, missionChildren, missionResult } from './phase.js';
import { STATE_ICON } from './ColonyPane.js';
import { pinnedSignals, signalLines } from './SignalsPane.js';
import { missionUsage } from './usage.js';
import { useMemo } from 'react';
import { createOutputRows, type OutputRow } from '../output-rows.js';
import { terminalText } from '../../core/terminal-text.js';
export { TABS } from './tabs.js';
export function missionLines(session: Session, ui: UiStoreState, tab: number, selected: string, ascii: boolean): Line[] {
  const main = ui.agents.main!,
    mission = latestMission(main);
  if (tab === 0)
    return planRows(session.swarm.board.read('/mission/plan')?.value, missionChildren(main, ui.meta.swarm)).map((row) => {
      const stats = row.agents.map((agent) => ui.meta.diffs?.[agent.id]?.result).filter((result) => result !== undefined);
      const summary = stats.length
        ? ` +${stats.reduce((n, result) => n + result.added, 0)} −${stats.reduce((n, result) => n + result.removed, 0)}`
        : '';
      return {
        target: { kind: 'plan-row', taskId: row.id, agentId: row.agents.at(-1)?.id },
        text: `${ascii ? (row.state === 'done' ? '+' : '*') : (STATE_ICON[row.state] ?? '·')} ${row.id} ${row.title} ${row.agents.map((agent) => agent.id).join(',') || '—'} ${row.state}${summary}`,
        tone: row.state === 'done' ? 'ok' : 'text',
      };
    });
  if (tab === 1) return agentLines(ui.agents[selected], ascii);
  if (tab === 2) {
    if (ui.meta.swarm.find((agent) => agent.id === selected)?.restored)
      return [{ text: '历史成员：工作区不可用 · 未合并 worktree 可用 roast worktrees list 查看', tone: 'muted' }];
    const entry = ui.meta.diffs?.[selected];
    if (!entry || entry.loading) return [{ text: '正在读取改动…', tone: 'muted' }];
    if (!entry.result) return [{ text: entry.error ?? '工作区不可用', tone: 'warn' }];
    const result = entry.result;
    return [
      { text: `${result.files} 文件 · +${result.added} −${result.removed}`, tone: 'accent' },
      ...`${result.stat}\n${result.diff}`
        .split('\n')
        .map((text): Line => ({ text, tone: text.startsWith('+') ? 'ok' : text.startsWith('-') ? 'error' : 'text' })),
      ...(result.truncated ? [{ text: '… diff 已截断', tone: 'muted' as const }] : []),
    ];
  }
  if (tab === 3) return ui.meta.messages.flatMap((message) => [messageLine(message, ascii), { text: message.body, tone: 'text' as const }]);
  if (tab === 4)
    return session.swarm.board.list('/').flatMap((entry) => [
      { text: `${entry.key} v${entry.version} · ${entry.author}`, tone: 'accent' as const },
      { text: session.swarm.board.read(entry.key)?.value ?? '', tone: 'text' as const },
    ]);
  if (tab === 5)
    return missionUsage(
      session.costBreakdown?.().entries ?? [],
      mission?.turn ?? 0,
      missionChildren(main, ui.meta.swarm).map((agent) => agent.id),
    );
  return signalLines(session, ui);
}
export function MissionPane({
  session,
  ui,
  tab,
  selected,
  height,
  width,
  focused,
  offset,
  outputRows,
  narrow = false,
  signals = false,
}: {
  session: Session;
  ui: UiStoreState;
  tab: number;
  selected: string;
  height: number;
  width: number;
  focused: boolean;
  offset: number;
  outputRows?: OutputRow[];
  narrow?: boolean;
  signals?: boolean;
}) {
  const theme = useTheme(),
    { ascii, hints } = useTerminal(),
    mission = latestMission(ui.agents.main!);
  const output = useMemo(createOutputRows, []);
  const raw = missionLines(session, ui, tab, selected, ascii);
  const empty =
    !raw.length ||
    (tab === 5 && raw.length === 1) ||
    (tab === 1 && raw[0]?.text === '（还没有输出）') ||
    (tab === 2 &&
      !ui.meta.diffs?.[selected]?.loading &&
      !ui.meta.diffs?.[selected]?.result &&
      !ui.meta.swarm.find((agent) => agent.id === selected)?.worktree &&
      !ui.meta.swarm.find((agent) => agent.id === selected)?.restored);
  const lines = empty && hints === 'full' ? [{ text: EMPTY_GUIDES[tab]!, tone: 'muted' as const }] : raw;
  const metrics = paneMetrics(width, height);
  const rich = outputRows ?? (ui.agents[selected] ? output(ui.agents[selected]!, metrics.width, ascii, 0, 0, true) : []);
  const shownRows = rich.length ? rich : [{ spans: [{ text: hints === 'full' ? EMPTY_GUIDES[1]! : '（还没有输出）', dim: true }] }];
  const member = ui.meta.swarm.find((agent) => agent.id === selected);
  const suffix = tabMemberSuffix(
    metrics.width - 2,
    tab,
    member ? terminalText(`${member.id === 'main' ? 'queen' : member.id} ${member.role}`) : undefined,
  );
  const tabs = missionTabs(Math.max(0, metrics.width - 2 - displayWidth(suffix)), tab, signals, ascii);
  const tabWidth = tabs.length ? tabs.at(-1)!.x + tabs.at(-1)!.width : 0;
  const titleContent = (
    <>
      {tabs.map((item, index) => (
        <Text key={item.tab}>
          {index ? <Text color={theme.muted}>{ascii ? '|' : '│'}</Text> : null}
          <Text color={item.tab === tab ? theme.accent : theme.muted} inverse={item.tab === tab}>
            {item.text}
          </Text>
        </Text>
      ))}
      {suffix ? (
        <Text color={theme.muted}>
          {' '.repeat(Math.max(0, metrics.width - 2 - tabWidth - displayWidth(suffix)))}
          {suffix}
        </Text>
      ) : null}
    </>
  );
  const title = missionTabs(Math.max(1, width - (height >= 4 && width >= 8 ? 4 : 0)), tab, signals)
    .map((item) => item.text)
    .join('');
  const recent = ui.agents.main!.items.filter((item) => item.kind === 'mission').slice(-3);
  return (
    <Pane
      title={title}
      titleContent={titleContent}
      {...(tab === 1
        ? { rows: shownRows }
        : { lines: tab === 6 ? lines.slice(pinnedSignals(ui).length) : lines, pinned: tab === 6 ? pinnedSignals(ui) : [] })}
      height={height}
      width={width}
      focused={focused}
      offset={offset}
      singleLine={tab === 0}
    >
      {tab === 0 &&
      ((!mission && !raw.length) || (session.resumedFrom && !ui.agents.main!.running && !session.swarm.board.read('/mission/plan'))) ? (
        hints === 'full' && !mission ? (
          <MissionGuide height={metrics.count} width={metrics.width} strategy={ui.meta.strategy ?? 'auto'} n={ui.meta.n ?? 3} />
        ) : (
          <Box flexGrow={1} justifyContent="center" alignItems="center" flexDirection="column">
            <Text dimColor>{ascii ? 'HIVE' : '⬡ HIVE'}</Text>
            {session.resumedFrom && recent.length ? (
              <>
                <Text dimColor>最近的任务</Text>
                {recent.map((item) =>
                  item.kind === 'mission' ? (
                    <Text key={item.id} dimColor wrap="truncate-end">
                      {terminalText(`${item.goal} · ${item.strategy} · ${missionResult(ui.agents.main!, item)}`)}
                    </Text>
                  ) : null,
                )}
              </>
            ) : null}
          </Box>
        )
      ) : undefined}
    </Pane>
  );
}
