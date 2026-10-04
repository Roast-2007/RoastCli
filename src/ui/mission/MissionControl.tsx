import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import type { Session } from '../../agent/session.js';
import type { UiController } from '../controller.js';
import type { UiStore } from '../store/store.js';
import { InteractionCard } from '../components/InteractionCard.js';
import { InputBox } from '../input/InputBox.js';
import { pickTheme, ThemeContext, useTheme, type Theme } from '../theme.js';
import { TerminalContext, terminalPreferences, useTerminal, useGlyphs } from '../terminal.js';
import { missionLayout } from '../layout.js';
import { formatContextStats } from '../format-context.js';
import { terminalText } from '../../core/terminal-text.js';
import { wrapDisplay } from '../../core/text-width.js';
import { agentLines, messageLine, treeOrder, windowLines, type Line, type LineTone } from './lines.js';

export interface MissionControlProps { session: Session; store: UiStore; controller: UiController; onExit(): void }
const STATE_ICON = { queued: '◌', running: '◉', waiting: '◎', paused: 'Ⅱ', done: '✓', failed: '✗', cancelled: '⊘' } as const;
const TABS = ['输出', '消息', '黑板', '上下文'] as const;
function toneColor(theme: Theme, tone: LineTone) {
  return tone === 'user' ? theme.user : tone === 'tool' || tone === 'accent' ? theme.accent : tone === 'ok' ? theme.success : tone === 'error' ? theme.danger : tone === 'warn' ? theme.warn : undefined;
}
function Pane({ title, lines, height, width, focus, offset = 0, fromTop = false }: { title: string; lines: Line[]; height: number; width: number; focus?: boolean; offset?: number; fromTop?: boolean }) {
  const theme = useTheme();
  const { ascii } = useTerminal();
  const border = height >= 4 && width >= 8;
  const count = Math.max(0, height - (border ? 2 : 0) - 1);
  const view = fromTop ? { shown: lines.slice(offset, offset + count), offset: 0 } : windowLines(lines, count, offset);
  return <Box flexDirection="column" width={width} height={height} flexShrink={0} overflow="hidden" borderStyle={border ? ascii ? 'classic' : 'round' : undefined} borderColor={focus ? theme.accent : theme.border} paddingX={border ? 1 : 0}>
    <Text bold color={theme.accent} wrap="truncate-end">{view.offset > 0 ? `↑ 已上翻 ${view.offset} 行 · G 到底部 · ` : ''}{title}</Text>
    {view.shown.map((line, i) => <Text key={i} color={toneColor(theme, line.tone)} dimColor={line.tone === 'muted'} wrap="truncate-end">{terminalText(line.text) || ' '}</Text>)}
  </Box>;
}
export function MissionControl(props: MissionControlProps) {
  const ui = useSyncExternalStore(props.store.subscribe, props.store.getState);
  const theme = pickTheme(process.env, ui.meta.theme ?? props.session.config.ui?.theme);
  const terminal = useMemo(() => terminalPreferences(process.env, props.session.config.ui), [props.session]);
  return <ThemeContext.Provider value={theme}><TerminalContext.Provider value={terminal}><Deck {...props} /></TerminalContext.Provider></ThemeContext.Provider>;
}
function Deck({ session, store, controller, onExit }: MissionControlProps) {
  const theme = useTheme();
  const { ascii } = useTerminal();
  const glyph = useGlyphs();
  const { rows, columns } = useWindowSize();
  const ui = useSyncExternalStore(store.subscribe, store.getState);
  const agents = useMemo(() => treeOrder(ui.meta.swarm), [ui.meta.swarm]);
  const [selected, setSelected] = useState(0);
  const [composing, setComposing] = useState(false);
  const [status, setStatus] = useState('');
  const [scroll, setScroll] = useState(0);
  const [tab, setTab] = useState(0);
  const [cancel, setCancel] = useState(false);
  const index = Math.min(selected, Math.max(0, agents.length - 1));
  const current = agents[index];
  const card = ui.meta.interactions[0];
  const footer = card ? Math.min(14, Math.max(2, rows - 3)) : composing ? Math.min(4, Math.max(1, rows - 3)) : 1;
  const layout = missionLayout(columns, rows, footer);
  const rawLines = tab === 0 ? agentLines(current ? ui.agents[current.id] : undefined, ascii) : tab === 1 ? ui.meta.messages.flatMap((m) => [messageLine(m, ascii), { text: m.body, tone: 'text' as const }]) : tab === 2 ? session.swarm.board.list('/').flatMap((m) => [{ text: `${m.key} v${m.version} · ${m.author}`, tone: 'accent' as const }, { text: JSON.stringify(session.swarm.board.read(m.key)?.value ?? ''), tone: 'text' as const }]) : formatContextStats(session.contextStats()).split('\n').map((text) => ({ text, tone: 'text' as const }));
  const focusLines = rawLines.flatMap((line) => wrapDisplay(terminalText(line.text), Math.max(1, layout.outputWidth - 4)).map((text) => ({ ...line, text })));
  const visible = Math.max(1, layout.bodyHeight - 3);
  const maxScroll = Math.max(0, focusLines.length - visible);
  const scrollOffset = Math.min(scroll, maxScroll);
  useEffect(() => { setScroll(scrollOffset); }, [scrollOffset]);
  useEffect(() => { store.setFocus(current?.id ?? 'main'); }, [store, current?.id]);
  useEffect(() => () => store.setFocus('main'), [store]);
  const select = (next: number) => { setSelected(Math.max(0, Math.min(agents.length - 1, next))); setScroll(0); setCancel(false); };
  useInput((input, key) => {
    if (composing) { if (key.escape) setComposing(false); return; }
    if (key.ctrl && input === 'c') { controller.interrupt(); return onExit(); }
    if (key.tab && key.shift) return controller.cycleMode();
    if (input === 'q' || key.escape || (key.ctrl && input === 'g')) return onExit();
    if (input === 'j' || key.downArrow) return select(index + 1);
    if (input === 'k' || key.upArrow) return select(index - 1);
    if (key.pageUp || input === 'b') return setScroll(Math.min(maxScroll, scrollOffset + visible));
    if (key.pageDown || input === 'f') return setScroll(Math.max(0, scrollOffset - visible));
    if (input === 'G') return setScroll(0);
    if (/^[1-4]$/.test(input) || key.tab) { setScroll(0); return setTab(key.tab ? (tab + 1) % TABS.length : Number(input) - 1); }
    if (input === 'm' && current) return setComposing(true);
    if (input === 'p' && current) return setStatus(controller.togglePause(current.id));
    if (input === 'x' && current) {
      if (!cancel) { setCancel(true); return setStatus(`再按 x 取消 ${current.id} 及其子 agent`); }
      controller.cancelAgent(current.id); setCancel(false); return setStatus(`已取消 ${current.id}`);
    }
  }, { isActive: card === undefined });
  const asciiState = { queued: '.', running: '*', waiting: 'o', paused: '||', done: '+', failed: 'x', cancelled: '-' };
  const treeLines: Line[] = agents.map((a, i) => ({ text: `${i === index ? glyph.pointer : ' '} ${'  '.repeat(a.depth)}${ascii ? asciiState[a.state] : STATE_ICON[a.state]} ${a.id} [${a.role}]${a.waitingFor ? ` ${a.waitingFor}` : ''}${a.worktree ? ` ${glyph.branch}` : ''}${a.report ? ` ${a.report.status}` : ''}`, tone: i === index ? 'accent' : a.state === 'done' ? 'ok' : a.state === 'failed' ? 'error' : 'text' }));
  const treeStart = Math.max(0, index - visible + 1);
  const timeline = ui.meta.messages.map((message) => messageLine(message, ascii));
  const board = session.swarm.board.list('/').map((m): Line => ({ text: `${m.key} v${m.version} · ${m.author}`, tone: 'muted' }));
  const sideTop = Math.floor(layout.bodyHeight / 2);
  return <Box flexDirection="column" height={layout.height} width={columns} overflow="hidden">
    <Text bold color={theme.accent} wrap="truncate-end">HIVE · MISSION CONTROL · {agents.length - 1} agents · {ui.meta.mode} · {TABS.map((name, i) => `${i + 1}${name}${tab === i ? ascii ? '*' : '●' : ''}`).join(' ')}</Text>
    {layout.bodyHeight > 0 ? <Box height={layout.bodyHeight} flexShrink={0}>
      {layout.treeWidth > 0 ? <Pane title="Agents · j/k" lines={treeLines} height={layout.bodyHeight} width={layout.treeWidth} focus offset={treeStart} fromTop /> : null}
      <Pane title={`${layout.treeWidth === 0 ? 'j/k 选择 · ' : ''}${current?.id ?? 'main'} · ${TABS[tab]}${session.loop.paused && current?.id === 'main' ? ' · 暂停' : ''} · ${current?.brief ?? ''}`} lines={focusLines} height={layout.bodyHeight} width={layout.outputWidth} offset={scrollOffset} />
      {layout.sideWidth > 0 ? <Box width={layout.sideWidth} flexDirection="column">
        <Pane title="消息 · 2 查看" lines={timeline} height={sideTop} width={layout.sideWidth} />
        <Pane title="黑板 · 3 查看" lines={board} height={layout.bodyHeight - sideTop} width={layout.sideWidth} />
      </Box> : null}
    </Box> : null}
    {card ? <InteractionCard key={card.id} request={card} maxHeight={footer} onRespond={(r) => controller.respond(card, r)} /> : composing ? <InputBox active placeholder={`给 ${current?.id} 发指示 · Esc 取消`} initialHistory={[]} deps={{ commands: [], files: () => [] }} maxHeight={footer} onSubmit={(text) => { if (current) setStatus(controller.steerAgent(current.id, text)); setComposing(false); }} /> : <Text dimColor wrap="truncate-end">{status || ui.meta.toast ? `${status || ui.meta.toast?.text} · q 返回` : 'j/k 选择 · Tab/1–4 视图 · b/f 翻页 · m 指示 · p 暂停 · x 取消 · q 返回'}</Text>}
  </Box>;
}
