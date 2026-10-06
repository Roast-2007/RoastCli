import path from 'node:path';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import type { Session } from '../../agent/session.js';
import type { RuntimeInput } from '../../agent/runtime.js';
import type { UiController } from '../controller.js';
import type { UiStore } from '../store/store.js';
import { ThemeContext, pickTheme, useTheme } from '../theme.js';
import { TerminalContext, terminalPreferences, useTerminal } from '../terminal.js';
import { InputBox } from '../input/InputBox.js';
import { createEditor, editorReducer, type EditorState } from '../input/editor.js';
import { suggestions } from '../input/suggest.js';
import { loadHistory } from '../input/history.js';
import { FileIndex } from '../input/files.js';
import { COMMANDS, skillCommands, mcpPromptCommands } from '../commands.js';
import { StatusLine } from '../components/Chrome.js';
import { InteractionCard } from '../components/InteractionCard.js';
import { ToolDetail } from '../components/ToolCard.js';
import { Overlay } from '../components/Overlay.js';
import { mouseWheel, useMouseReporting } from '../mouse.js';
import { gitBranch, formatCost } from '../status-info.js';
import { VERSION } from '../../core/version.js';
import { deckLayout } from './layout.js';
import { nextFocus, type DeckFocus } from './focus.js';
import { treeOrder } from './lines.js';
import { ColonyPane, colonyLines } from './ColonyPane.js';
import { MissionPane, missionLines } from './MissionPane.js';
import { SignalsPane, signalLines } from './SignalsPane.js';
import { Pane, paneMaxOffset } from './Pane.js';
import { latestMission, missionPhase } from './phase.js';

export interface DeckProps { session: Session; store: UiStore; controller: UiController; onExit(): void; inputDraft?: { seed?: number; state?: EditorState }; initialPrompt?: RuntimeInput; startup?: boolean }
export function Deck(props: DeckProps) {
  const ui = useSyncExternalStore(props.store.subscribe, props.store.getState);
  const theme = pickTheme(process.env, ui.meta.theme ?? props.session.config.ui?.theme);
  const terminal = useMemo(() => terminalPreferences(process.env, props.session.config.ui), [props.session]);
  return <ThemeContext.Provider value={theme}><TerminalContext.Provider value={terminal}><Workspace {...props} /></TerminalContext.Provider></ThemeContext.Provider>;
}
function Workspace({ session, store, controller, onExit, inputDraft, initialPrompt }: DeckProps) {
  const { exit } = useApp(), theme = useTheme(), { ascii } = useTerminal();
  const { rows, columns } = useWindowSize();
  const ui = useSyncExternalStore(store.subscribe, store.getState), main = ui.agents.main!;
  const localDraft = useRef<{ seed?: number; state?: EditorState }>({}), draft = inputDraft ?? localDraft.current;
  const [focus, setFocus] = useState<DeckFocus>('input'), focusRef = useRef(focus);
  const changeFocus = (next: DeckFocus) => { focusRef.current = next; setFocus(next); };
  const [selected, setSelected] = useState('main'), [tab, setTab] = useState(0), [narrow, setNarrow] = useState(1);
  const [offset, setOffset] = useState(0), [signalOffset, setSignalOffset] = useState(0), [colonyOffset, setColonyOffset] = useState(0), [detail, setDetail] = useState(false);
  const nav = useRef({ offset, tab, narrow }); nav.current = { offset, tab, narrow };
  const cancel = useRef<string | null>(null), lastEsc = useRef(0), escHint = useRef(false);
  const [now, setNow] = useState(Date.now());
  const cwd = session.log.header.cwd, history = useMemo(() => loadHistory(cwd), [cwd]), files = useMemo(() => new FileIndex(cwd), [cwd]);
  const deps = useMemo(() => ({ commands: [...COMMANDS, ...skillCommands(session.skills.list()), ...mcpPromptCommands(session)], files: (q: string) => files.match(q), members: (q: string) => ['queen', ...ui.meta.swarm.filter((agent) => agent.parentId).map((agent) => agent.id)].filter((id) => id.startsWith(q)) }), [session, files, ui.meta.swarm]);
  const agents = useMemo(() => treeOrder(ui.meta.swarm), [ui.meta.swarm]);
  const current = agents.find((agent) => agent.id === selected) ?? agents[0];
  const card = ui.meta.interactions[0], layout = deckLayout(columns, rows, Boolean(card));
  const branch = useMemo(() => gitBranch(cwd), [cwd, main.running]);
  const mission = latestMission(main), phase = missionPhase(main, agents);
  useMouseReporting();
  useEffect(() => { controller.setScreen('hive'); }, [controller]);
  useEffect(() => { store.setFocus(current?.id ?? 'main'); return () => store.setFocus('main'); }, [store, current?.id]);
  useEffect(() => { if (!main.running) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [main.running]);
  const auto = useRef(false);
  useEffect(() => { if (initialPrompt && !auto.current) { auto.current = true; controller.submit(initialPrompt, typeof initialPrompt === 'string' ? initialPrompt : 'kind' in initialPrompt ? initialPrompt.goal : ''); } }, [initialPrompt, controller]);
  const selectedView = ui.agents[current?.id ?? 'main'];
  const lastTool = selectedView?.items.slice().reverse().find((item) => item.kind === 'tool' || item.kind === 'tool-group');
  const tool = selectedView?.tools.at(-1) ?? (lastTool?.kind === 'tool' ? lastTool.tool : lastTool?.kind === 'tool-group' ? lastTool.tools.at(-1) : undefined);
  const raw = missionLines(session, ui, tab, current?.id ?? 'main', ascii);
  const maxOffset = paneMaxOffset(raw, layout.mission, layout.body);
  const signalMax = paneMaxOffset(signalLines(session, ui), layout.signals, layout.body);
  const colonyMax = paneMaxOffset(colonyLines(agents, ui.agents, selected, ascii), layout.colony || columns, layout.body);
  const move = (delta: number) => { if (focusRef.current === 'signals') { setSignalOffset((n) => Math.max(0, Math.min(signalMax, n + delta))); return; } nav.current.offset = Math.max(0, Math.min(maxOffset, nav.current.offset + delta)); setOffset(nav.current.offset); };
  const select = (delta: number) => { const index = Math.max(0, Math.min(agents.length - 1, agents.findIndex((agent) => agent.id === current?.id) + delta)); setSelected(agents[index]?.id ?? 'main'); setColonyOffset(Math.min(colonyMax, Math.max(0, index - Math.max(1, layout.body - 4) + 1))); setOffset(0); cancel.current = null; };
  const pickTab = (next: number) => { nav.current.tab = next; setTab(next); setOffset(0); if (layout.narrow) setNarrow(1); };
  useInput((input, key) => {
    const wheel = mouseWheel(input);
    if (wheel !== null) { if (!wheel || detail) return; if (focusRef.current === 'colony') setColonyOffset((n) => Math.max(0, Math.min(colonyMax, n + wheel))); else move(-wheel); return; }
    if (key.ctrl && input === 'g') return onExit();
    if (key.ctrl && input === 'c') return controller.isRunning() ? controller.interrupt() : exit();
    if (key.tab && key.shift) return controller.cycleMode();
    if (key.ctrl && input === 'o') return setDetail((value) => !value);
    if (detail) { if (key.escape) setDetail(false); return; }
    if (key.tab) {
      if (focusRef.current === 'input' && suggestions(draft.state ?? createEditor(history), deps).length) return;
      return changeFocus(nextFocus(focusRef.current, layout.signals > 0));
    }
    if (focusRef.current === 'input') {
      if (key.escape) {
        if (controller.isRunning()) return controller.interrupt();
        const at = Date.now();
        if (at - lastEsc.current < 600) { lastEsc.current = 0; return controller.runCommand('/rewind'); }
        lastEsc.current = at;
        if (!escHint.current) { escHint.current = true; store.addNotice('main', '再次按 Esc 可打开回退菜单（文件与对话）'); }
      }
      if (key.pageUp) { changeFocus('mission'); move(Math.max(1, layout.body - 3)); }
      return;
    }
    if (key.escape || input === 'i') return changeFocus('input');
    if (/^[1-7]$/.test(input)) return pickTab(layout.signals === 0 && !layout.narrow ? [0, 1, 2, 6, 3, 4, 5][Number(input) - 1]! : Number(input) === 7 ? 6 : Number(input) - 1);
    if (input === '[' || input === ']') { const next = (nav.current.narrow + (input === '[' ? 4 : 1)) % 5; nav.current.narrow = next; setNarrow(next); if (next > 0) { setTab([0, 0, 1, 2, 6][next]!); setOffset(0); } return; }
    if (input === 'm' && current) { const text = `@${current.id === 'main' ? 'queen' : current.id} `; draft.state = editorReducer(draft.state ?? createEditor(history), { type: 'set', text }); store.setMeta((meta) => ({ inputSeed: { key: meta.inputSeed.key + 1, text } })); draft.seed = store.getState().meta.inputSeed.key; return changeFocus('input'); }
    if (input === 'p' && current) return store.addNotice('main', controller.togglePause(current.id));
    if (input === 'x' && current) { if (cancel.current === current.id) { cancel.current = null; return controller.cancelAgent(current.id); } cancel.current = current.id; return store.setMeta({ toast: { text: `再按 x 取消 ${current.id} 及其子 agent`, tone: 'warn' } }); }
    if (input === 'd') return pickTab(2);
    if (focusRef.current === 'colony') {
      if (key.upArrow || input === 'k') return select(-1);
      if (key.downArrow || input === 'j') return select(1);
      if (key.home || input === 'g') return setSelected(agents[0]?.id ?? 'main');
      if (key.end || input === 'G') return setSelected(agents.at(-1)?.id ?? 'main');
      if (key.return) { pickTab(1); return changeFocus('mission'); }
    }
    if (key.upArrow || input === 'k') move(1);
    if (key.downArrow || input === 'j') move(-1);
    if (key.pageUp || input === 'b') move(Math.max(1, layout.body - 4));
    if (key.pageDown || input === 'f') move(-Math.max(1, layout.body - 4));
    if (key.home || input === 'g') move(focusRef.current === 'signals' ? signalMax : maxOffset);
    if (key.end || input === 'G') move(-(focusRef.current === 'signals' ? signalMax : maxOffset));
  }, { isActive: !card && !ui.meta.overlay });
  const cost = session.cost(), runningChildren = agents.filter((agent) => agent.parentId && ['queued', 'running', 'waiting', 'paused'].includes(agent.state)).length;
  const center = <MissionPane session={session} ui={ui} tab={tab} selected={current?.id ?? 'main'} height={layout.body} width={layout.mission} focused={focus === 'mission'} offset={offset} narrow={layout.narrow} signals={!layout.signals && !layout.narrow} />;
  return <Box height={layout.height} width={columns} flexDirection="column" overflow="hidden">
    {layout.header ? <Text bold color={theme.accent} wrap="truncate-end">ROAST HIVE v{VERSION} · {session.providerName}:{session.model} · {path.basename(cwd)} {branch ? `⎇ ${branch}` : ''} · {phase}{mission ? ` #${mission.missionId.slice(1)} · ${mission.strategy} · ${mission.goal}` : ''}</Text> : null}
    {ui.meta.overlay && !card ? <Overlay kind={ui.meta.overlay} session={session} store={store} controller={controller} height={layout.body + layout.input} /> : <>
      {layout.body ? detail && !card ? <Box height={layout.body} overflow="hidden"><ToolDetail tool={tool} width={columns} maxLines={layout.body} active /></Box> : layout.compact ? <Text wrap="truncate-end">HIVE {runningChildren}/{session.config.swarm.maxAgents} · {phase}</Text> : <Box height={layout.body} flexShrink={0}>
        {layout.colony > 0 ? <ColonyPane agents={agents} views={ui.agents} selected={current?.id ?? 'main'} height={layout.body} width={layout.colony} focused={focus === 'colony'} offset={colonyOffset} /> : null}
        {layout.narrow && (narrow === 0 || focus === 'colony') ? <Pane title="蜂群 计划 输出 改动 信号" lines={colonyLines(agents, ui.agents, current?.id ?? 'main', ascii)} width={columns} height={layout.body} focused={focus === 'colony'} offset={colonyOffset} fromTop /> : center}
        {layout.signals > 0 ? <SignalsPane session={session} ui={ui} height={layout.body} width={layout.signals} focused={focus === 'signals'} offset={signalOffset} /> : null}
      </Box> : null}
      <Box height={layout.input} flexShrink={0} flexDirection="column" overflow="hidden">
        {card ? <InteractionCard key={card.id} request={card} maxHeight={layout.input} onRespond={(response) => controller.respond(card, response)} /> : <>
          {layout.input >= 4 ? <Text dimColor wrap="truncate-end">策略 {ui.meta.strategy ?? 'auto'} · n {ui.meta.n ?? 3}</Text> : null}
          <InputBox key={ui.meta.inputSeed.key} active={focus === 'input' && !detail} acceptInput={() => focusRef.current === 'input' && !detail && !store.getState().meta.overlay && !store.getState().meta.interactions.length} placeholder={main.running ? '插话，或 @成员 发指示' : '输入目标'} initialHistory={history} initialText={ui.meta.inputSeed.text} initialState={draft.seed === ui.meta.inputSeed.key ? draft.state : undefined} onStateChange={(state) => { draft.seed = ui.meta.inputSeed.key; draft.state = state; }} deps={deps} maxHeight={layout.input - (layout.input >= 4 ? 1 : 0)} onHelp={() => store.setMeta({ overlay: 'help' })} onSubmit={(text, raw) => controller.submit(text, raw)} />
        </>}
      </Box>
    </>}
    {layout.status ? <StatusLine mode={ui.meta.mode} model={`${session.providerName}:${session.model}`} contextPercent={ui.meta.contextPercent} total={main.totalUsage} last={main.lastUsage} running={main.running} elapsedMs={main.turnStartedAt ? now - main.turnStartedAt : 0} step={main.step} cost={cost === null ? null : formatCost(cost)} branch={branch} agents={runningChildren} toast={ui.meta.toast} /> : null}
  </Box>;
}
