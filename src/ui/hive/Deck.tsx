import { KeyBar, keyHints, fitKeyHints } from '../components/KeyBar.js';
import type { InputActions } from '../input/InputBox.js';
import type { ApprovalActions } from '../components/InteractionCard.js';
import { deckRegions } from './hitmap.js';
import { createDeckMouse } from './deck-mouse.js';
import { AgentMenu } from './AgentMenu.js';
import { displayWidth } from '../../core/text-width.js';
import { useDeckFunctionKeys } from './function-keys.js';
import { useViewport } from '../viewport.js';
import path from 'node:path';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type { Session } from '../../agent/session.js';
import type { RuntimeInput } from '../../agent/runtime.js';
import type { UiController } from '../controller.js';
import type { UiStore } from '../store/store.js';
import { ThemeContext, pickTheme, useTheme } from '../theme.js';
import { TerminalContext, terminalPreferences, useTerminal } from '../terminal.js';
import { InputBox } from '../input/InputBox.js';
import { createEditor, editorReducer, textOf, type EditorState } from '../input/editor.js';
import { suggestions } from '../input/suggest.js';
import { loadHistory } from '../input/history.js';
import { FileIndex } from '../input/files.js';
import { COMMANDS, skillCommands, mcpPromptCommands } from '../commands.js';
import { StatusLine, modeWidth } from '../components/Chrome.js';
import { InteractionCard } from '../components/InteractionCard.js';
import { ToolDetail } from '../components/ToolCard.js';
import { Overlay } from '../components/Overlay.js';
import { parseMouse, useMouseReporting } from '../mouse.js';
import { gitBranch, formatCost } from '../status-info.js';
import { VERSION } from '../../core/version.js';
import { deckLayout } from './layout.js';
import { nextFocus, type DeckFocus } from './focus.js';
import { treeOrder } from './lines.js';
import { ColonyPane, colonyLines } from './ColonyPane.js';
import { MissionPane, missionLines } from './MissionPane.js';
import { SignalsPane, signalLines, pinnedSignals } from './SignalsPane.js';
import { Pane, paneMaxOffset, paneLines, paneMetrics } from './Pane.js';
import { latestMission, missionPhase } from './phase.js';
import { Ignition } from './Ignition.js';
import { QueueLine } from './QueueLine.js';
import { useDiffReviews } from './diffs.js';
import { createOutputRows, outputPadding } from '../output-rows.js';
import { ZoomPane } from './ZoomPane.js';
import { usePlanZoom } from './PlanZoom.js';
import { planDetailLines } from './plan-view.js';
import { latestTool, toolsOf } from '../tool-nav.js';
import { useScroll } from '../scroll.js';
import type { ToolDetailActions } from '../components/ToolDetail.js';
import { terminalText } from '../../core/terminal-text.js';
import { strategyLabel } from '../strategy.js';
import { parsePlan } from './plan.js';

export interface DeckProps {
  session: Session;
  store: UiStore;
  controller: UiController;
  onExit(): void;
  inputDraft?: { seed?: number; state?: EditorState };
  initialPrompt?: RuntimeInput;
  startup?: boolean;
}
export function Deck(props: DeckProps) {
  const ui = useSyncExternalStore(props.store.subscribe, props.store.getState);
  const theme = pickTheme(process.env, ui.meta.theme ?? props.session.config.ui?.theme);
  const terminal = useMemo(
    () => terminalPreferences(process.env, { ...props.session.config.ui, mouse: ui.meta.mouse ?? props.session.config.ui?.mouse }),
    [props.session, ui.meta.mouse],
  );
  return (
    <ThemeContext.Provider value={theme}>
      <TerminalContext.Provider value={terminal}>
        <Workspace {...props} />
      </TerminalContext.Provider>
    </ThemeContext.Provider>
  );
}
function Workspace({ session, store, controller, onExit, inputDraft, initialPrompt, startup }: DeckProps) {
  const { exit } = useApp(),
    theme = useTheme(),
    { ascii, motion, mouse, hints } = useTerminal();
  const { rows, columns } = useViewport();
  const ui = useSyncExternalStore(store.subscribe, store.getState),
    main = ui.agents.main!;
  const localDraft = useRef<{ seed?: number; state?: EditorState }>({}),
    draft = inputDraft ?? localDraft.current;
  const [splash, setSplash] = useState(Boolean(startup && motion && !initialPrompt));
  const [focus, setFocus] = useState<DeckFocus>('input'),
    focusRef = useRef(focus);
  const changeFocus = (next: DeckFocus) => {
    focusRef.current = next;
    setFocus(next);
  };
  const [menu, setMenu] = useState<string | null>(null);
  const inputActions = useRef<InputActions | null>(null),
    approvalActions = useRef<ApprovalActions | null>(null),
    toolScroll = useRef<(() => void) | null>(null);
  const toolActions = useRef<ToolDetailActions | null>(null);
  const handleMouse = useRef(createDeckMouse());
  const [selected, setSelected] = useState('main'),
    [tab, setTab] = useState(() =>
      session.resumedFrom && latestMission(main) && !parsePlan(session.swarm.board.read('/mission/plan')?.value)?.length ? 1 : 0,
    ),
    [narrow, setNarrow] = useState(1);
  const [zoom, setZoom] = useState(false),
    [zoomFollow, setZoomFollow] = useState(true),
    [detailCall, setDetailCall] = useState<string>();
  const [offset, setOffset] = useState(0),
    [signalOffset, setSignalOffset] = useState(0),
    [colonyOffset, setColonyOffset] = useState(0),
    [detail, setDetail] = useState(false);
  const nav = useRef({ offset, tab, narrow });
  nav.current = { offset, tab, narrow };
  const cancel = useRef<string | null>(null),
    lastEsc = useRef(0),
    escHint = useRef(false);
  const [now, setNow] = useState(Date.now());
  const cwd = session.log.header.cwd,
    history = useMemo(() => loadHistory(cwd), [cwd]),
    files = useMemo(() => new FileIndex(cwd), [cwd]);
  const deps = useMemo(
    () => ({
      commands: [...COMMANDS, ...skillCommands(session.skills.list()), ...mcpPromptCommands(session)],
      files: (q: string) => files.match(q),
      members: (q: string) =>
        ['queen', ...ui.meta.swarm.filter((agent) => agent.parentId).map((agent) => agent.id)].filter((id) => id.startsWith(q)),
    }),
    [session, files, ui.meta.swarm],
  );
  const agents = useMemo(() => treeOrder(ui.meta.swarm), [ui.meta.swarm]);
  const current = agents.find((agent) => agent.id === selected) ?? agents[0];
  const card = ui.meta.interactions[0],
    layout = deckLayout(columns, rows, Boolean(card), hints !== 'off');
  useEffect(() => {
    if (focus === 'signals' && !layout.signals) changeFocus('mission');
  }, [focus, layout.signals]);
  const branch = useMemo(() => gitBranch(cwd), [cwd, main.running]);
  const mission = latestMission(main),
    phase = missionPhase(main, agents);
  useDiffReviews(session, store, ui, current?.id ?? 'main', !splash && tab === 2 && !card && !ui.meta.overlay);
  const openHelp = () => store.setMeta({ overlay: 'help' });
  useMouseReporting();
  useDeckFunctionKeys(
    !splash && !card && !ui.meta.overlay && !detail && !menu,
    (reverse) => changeFocus(nextFocus(focusRef.current, layout.signals > 0, reverse)),
    openHelp,
  );
  useEffect(() => {
    controller.setScreen('hive');
  }, [controller]);
  useEffect(() => {
    store.setFocus(current?.id ?? 'main');
    return () => store.setFocus('main');
  }, [store, current?.id]);
  useEffect(() => {
    if (!main.running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [main.running]);
  const auto = useRef(false);
  useEffect(() => {
    if (initialPrompt && !auto.current) {
      auto.current = true;
      controller.submit(
        initialPrompt,
        typeof initialPrompt === 'string' ? initialPrompt : 'kind' in initialPrompt ? initialPrompt.goal : '',
      );
    }
  }, [initialPrompt, controller]);
  const selectedView = ui.agents[current?.id ?? 'main'];
  const tools = useMemo(() => (selectedView ? toolsOf(selectedView) : []), [selectedView]);
  const openDetail = (callId = selectedView ? latestTool(selectedView)?.callId : undefined) => {
    setDetailCall(callId);
    setDetail(true);
  };
  const output = useMemo(createOutputRows, []),
    fullOutput = useMemo(createOutputRows, []);
  const outputRows = useMemo(
    () =>
      selectedView && tab === 1 && !layout.compact
        ? output(selectedView, paneMetrics(layout.mission, layout.body).width, ascii, 0, 0, true)
        : [],
    [output, selectedView, tab, layout.compact, layout.mission, layout.body, ascii],
  );
  const padding = outputPadding(columns, session.config.ui?.markdown?.padding);
  const zoomRows = useMemo(
    () =>
      selectedView && zoom
        ? fullOutput(selectedView, Math.max(1, columns - 2 * padding), ascii, session.config.ui?.markdown?.spacing ?? 1)
        : [],
    [fullOutput, selectedView, zoom, columns, padding, ascii, session],
  );
  const zoomCount = Math.max(0, layout.body - 1),
    zoomScroll = useScroll(zoomRows.length, zoomCount);
  const zoomStart = zoomFollow ? zoomScroll.max : zoomScroll.start;
  const planLines = planDetailLines(session.swarm.board.read('/mission/plan')?.value, ui, Math.max(1, columns - 2 * padding), ascii);
  const planZoom = usePlanZoom(planLines, zoomCount, { tab, narrow, selected, offset }, (nav) => {
    setTab(nav.tab);
    setNarrow(nav.narrow);
    setSelected(nav.selected);
    setOffset(nav.offset);
  });
  const expanded = zoom || planZoom.active;
  const hintItems = keyHints({
    screen: 'hive',
    focus,
    running: main.running,
    card,
    detail,
    zoom: expanded,
    plan: tab === 0,
    output: tab === 1,
    tabs: !layout.signals && !layout.narrow ? 7 : 6,
  });
  const closeZoom = () => {
    if (planZoom.active) planZoom.close();
    else setZoom(false);
  };
  const enterPlan = (target?: Parameters<typeof planZoom.enter>[0]) => {
    if (layout.compact || !layout.body) return;
    planZoom.enter(target);
    changeFocus('mission');
  };
  const enterZoom = () => {
    if (!layout.compact && layout.body && tab === 1) {
      zoomScroll.move(zoomScroll.max);
      setZoomFollow(true);
      setZoom(true);
      changeFocus('mission');
    }
  };
  const scrollZoom = (delta: number) => {
    if (planZoom.active) return planZoom.move(delta);
    const next = Math.max(0, Math.min(zoomScroll.max, (zoomFollow ? zoomScroll.max : zoomScroll.position()) + delta));
    zoomScroll.move(next);
    setZoomFollow(next === zoomScroll.max);
  };
  const raw = missionLines(session, ui, tab, current?.id ?? 'main', ascii, paneMetrics(layout.mission, layout.body).width);
  const maxOffset =
    tab === 1
      ? Math.max(0, outputRows.length - paneMetrics(layout.mission, layout.body).count)
      : paneMaxOffset(raw, layout.mission, layout.body, tab === 0);
  useEffect(() => {
    if (selected !== 'main' && !ui.meta.swarm.some((agent) => agent.id === selected)) {
      setSelected('main');
      setOffset(0);
      setZoom(false);
    }
  }, [ui.meta.swarm, selected]);
  useEffect(() => {
    if (tab === 2 && ui.meta.diffs?.[selected]?.result) {
      nav.current.offset = maxOffset;
      setOffset(maxOffset);
    }
  }, [tab, selected, ui.meta.diffs?.[selected]?.result]);
  const signalMax = paneMaxOffset(signalLines(session, ui), layout.signals, layout.body);
  const colonyMax = paneMaxOffset(colonyLines(agents, ui.agents, selected, ascii), layout.colony || columns, layout.body, true);
  const move = (delta: number) => {
    if (expanded) return scrollZoom(-delta);
    if (focusRef.current === 'signals') {
      setSignalOffset((n) => Math.max(0, Math.min(signalMax, n + delta)));
      return;
    }
    nav.current.offset = Math.max(0, Math.min(maxOffset, nav.current.offset + delta));
    setOffset(nav.current.offset);
  };
  const select = (delta: number) => {
    const index = Math.max(0, Math.min(agents.length - 1, agents.findIndex((agent) => agent.id === current?.id) + delta));
    setSelected(agents[index]?.id ?? 'main');
    setColonyOffset(Math.min(colonyMax, Math.max(0, index - Math.max(1, layout.body - 4) + 1)));
    setOffset(0);
    cancel.current = null;
  };
  const pickTab = (next: number) => {
    nav.current.tab = next;
    setTab(next);
    setOffset(0);
    if (layout.narrow) setNarrow(1);
  };
  const openSignal = (target: Extract<import('./hitmap.js').Target, { kind: 'signal' }>) => {
    if (target.type === 'approval') {
      const request = ui.meta.interactions.find((item) => item.id === target.id);
      if (request) store.setMeta({ interactions: [request, ...ui.meta.interactions.filter((item) => item.id !== request.id)] });
    }
    if (target.type === 'message') {
      setSelected(target.id);
      pickTab(3);
      changeFocus('mission');
    }
    if (target.type === 'board') {
      pickTab(4);
      changeFocus('mission');
      const lines = paneLines(missionLines(session, ui, 4, selected, ascii), layout.mission, layout.body);
      const index = lines.findIndex((line) => line.text.startsWith(target.id + ' '));
      nav.current.offset = Math.max(0, lines.length - paneMetrics(layout.mission, layout.body).count - Math.max(0, index));
      setOffset(nav.current.offset);
    }
  };
  useInput(
    (input, key) => {
      if (input === '\ue019' || input === '\ue014') return;
      if (parseMouse(input).length) return;
      if (key.ctrl && input === 'g') return onExit();
      if (key.ctrl && input === 'c') {
        if (controller.ctrlC(draft.state ? textOf(draft.state) : '') === 'clear') {
          draft.state = editorReducer(draft.state ?? createEditor(history), { type: 'set', text: '' });
          store.setMeta((m) => ({ inputSeed: { key: m.inputSeed.key + 1, text: '', screen: 'hive' } }));
          draft.seed = store.getState().meta.inputSeed.key;
        }
        return;
      }
      if (key.tab && key.shift && focusRef.current === 'input') return controller.cycleMode();
      if (key.ctrl && input === 'o') return detail ? setDetail(false) : openDetail();
      if (detail) {
        if (key.escape) setDetail(false);
        return;
      }
      if (key.tab) {
        if (focusRef.current === 'input') return;
        return changeFocus(nextFocus(focusRef.current, layout.signals > 0, key.shift));
      }
      if (focusRef.current === 'input') {
        if (key.escape) {
          if (controller.isRunning()) return controller.interrupt();
          const at = Date.now();
          if (at - lastEsc.current < 600) {
            lastEsc.current = 0;
            return controller.runCommand('/rewind');
          }
          lastEsc.current = at;
          if (!escHint.current) {
            escHint.current = true;
            store.addNotice('main', '再次按 Esc 可打开回退菜单（文件与对话）');
          }
        }
        if (key.pageUp) {
          changeFocus('mission');
          move(Math.max(1, layout.body - 3));
        }
        return;
      }
      if (expanded) {
        if (key.escape) return closeZoom();
        if (key.upArrow || input === 'k') return scrollZoom(-1);
        if (key.downArrow || input === 'j') return scrollZoom(1);
        if (key.pageUp || input === 'b') return scrollZoom(-Math.max(1, zoomCount - 1));
        if (key.pageDown || input === 'f') return scrollZoom(Math.max(1, zoomCount - 1));
        if (key.home || input === 'g') return scrollZoom(-(planZoom.active ? planLines.length : zoomRows.length));
        if (key.end || input === 'G') return scrollZoom(planZoom.active ? planLines.length : zoomRows.length);
        if (input && !key.ctrl && !key.meta && /^[^\x00-\x1f\x7f]+$/.test(input)) {
          const state = editorReducer(draft.state ?? createEditor(history), { type: 'insert', text: input });
          draft.state = state;
          store.setMeta((meta) => ({ inputSeed: { key: meta.inputSeed.key + 1, text: textOf(state), screen: 'hive' } }));
          draft.seed = store.getState().meta.inputSeed.key;
          changeFocus('input');
        }
        return;
      }
      if (key.return && focusRef.current === 'mission' && tab === 1) return enterZoom();
      if (key.return && focusRef.current === 'mission' && tab === 0) return enterPlan();
      if (input === '?') return openHelp();
      if (focusRef.current === 'colony' && input === ' ') return setMenu(current?.id ?? 'main');
      if (key.return && focusRef.current === 'signals') {
        const region = regions.find((region) => region.target.kind === 'signal');
        if (region?.target.kind === 'signal') openSignal(region.target);
        return;
      }
      if (key.escape || input === 'i') return changeFocus('input');
      if (input !== 'x') cancel.current = null;
      if (/^[1-7]$/.test(input))
        return pickTab(
          layout.signals === 0 && !layout.narrow ? [0, 1, 2, 6, 3, 4, 5][Number(input) - 1]! : Number(input) === 7 ? 6 : Number(input) - 1,
        );
      if (layout.narrow && (input === '[' || input === ']')) {
        const next = (nav.current.narrow + (input === '[' ? 4 : 1)) % 5;
        nav.current.narrow = next;
        setNarrow(next);
        if (next > 0) {
          setTab([0, 0, 1, 2, 6][next]!);
          setOffset(0);
        }
        return;
      }
      if (input === 'm' && current) {
        const text = `@${current.id === 'main' ? 'queen' : current.id} `;
        draft.state = editorReducer(draft.state ?? createEditor(history), { type: 'set', text });
        store.setMeta((meta) => ({ inputSeed: { key: meta.inputSeed.key + 1, text, screen: 'hive' } }));
        draft.seed = store.getState().meta.inputSeed.key;
        return changeFocus('input');
      }
      if (input === 'p' && current) return store.addNotice('main', controller.togglePause(current.id));
      if (input === 'x' && current) {
        if (cancel.current === current.id) {
          cancel.current = null;
          return controller.cancelAgent(current.id);
        }
        cancel.current = current.id;
        return store.setMeta({ toast: { text: `再按 x 取消 ${current.id} 及其子 agent`, tone: 'warn' } });
      }
      if (input === 'd') return pickTab(2);
      if (focusRef.current === 'colony') {
        if (key.pageUp) return select(-Math.max(1, layout.body - 3));
        if (key.pageDown) return select(Math.max(1, layout.body - 3));
        if (key.upArrow || input === 'k') return select(-1);
        if (key.downArrow || input === 'j') return select(1);
        if (key.home || input === 'g') return select(-agents.length);
        if (key.end || input === 'G') return select(agents.length);
        if (key.return) {
          pickTab(1);
          return changeFocus('mission');
        }
      }
      if (key.upArrow || input === 'k') move(1);
      if (key.downArrow || input === 'j') move(-1);
      if (key.pageUp || input === 'b') move(Math.max(1, layout.body - 4));
      if (key.pageDown || input === 'f') move(-Math.max(1, layout.body - 4));
      if (key.home || input === 'g') move(focusRef.current === 'signals' ? signalMax : maxOffset);
      if (key.end || input === 'G') move(-(focusRef.current === 'signals' ? signalMax : maxOffset));
      if (input && !key.ctrl && !key.meta && /^[^\x00-\x1f\x7f]+$/.test(input) && !/^[jkgGbfmpxdi0-9\[\]]$/.test(input)) {
        const state = editorReducer(draft.state ?? createEditor(history), { type: 'insert', text: input });
        draft.state = state;
        store.setMeta((meta) => ({ inputSeed: { key: meta.inputSeed.key + 1, text: textOf(state), screen: 'hive' } }));
        draft.seed = store.getState().meta.inputSeed.key;
        changeFocus('input');
      }
    },
    { isActive: !splash && !card && !ui.meta.overlay && !menu },
  );
  const chip = strategyLabel(session, ui.meta);
  const regions = deckRegions(layout, {
    focus,
    narrow,
    tab,
    agents: agents.map((agent) => agent.id),
    colonyOffset: Math.min(colonyOffset, colonyMax),
    offset: Math.min(offset, maxOffset),
    signalOffset: Math.min(signalOffset, signalMax),
    missionLines: raw,
    outputRows,
    outputAgentId: current?.id,
    ...(expanded
      ? {
          zoom: {
            rows: planZoom.active ? planLines : zoomRows,
            start: planZoom.active ? planZoom.start : zoomStart,
            padding,
            agentId: current?.id ?? 'main',
            plan: planZoom.active,
          },
        }
      : {}),
    signalLines: signalLines(session, ui),
    signalPinned: pinnedSignals(ui),
    memberLabel: current ? `${current.id === 'main' ? 'queen' : current.id} ${current.role}` : undefined,
    modeWidth: modeWidth(ui.meta.mode),
    strategyWidth: displayWidth(chip),
    interaction: Boolean(card),
    hints: fitKeyHints(hintItems, columns),
  });
  const prefill = (id: string) => {
    const text = `@${id === 'main' ? 'queen' : id} `;
    draft.state = editorReducer(draft.state ?? createEditor(history), { type: 'set', text });
    store.setMeta((meta) => ({ inputSeed: { key: meta.inputSeed.key + 1, text, screen: 'hive' } }));
    draft.seed = store.getState().meta.inputSeed.key;
    changeFocus('input');
  };
  const runHint = (action: string) => {
    if (card) {
      if (action.startsWith('approve:')) approvalActions.current?.choose(Number(action.slice(8)));
      else if (action === 'approval-next') approvalActions.current?.next();
      return;
    }
    if (action === 'submit') inputActions.current?.enter();
    if (action === 'help') openHelp();
    if (action === 'interrupt') controller.interrupt();
    if (action === 'switch') onExit();
    if (action === 'mention' || action === 'commands') {
      changeFocus('input');
      inputActions.current?.insert(action === 'mention' ? '@' : '/');
    }
    if (action === 'input') changeFocus('input');
    if (action === 'focus-next') changeFocus(nextFocus(focusRef.current, layout.signals > 0));
    if (action === 'tool-open') openDetail();
    if (action === 'tool-close') setDetail(false);
    if (action === 'tool-previous') toolActions.current?.previous();
    if (action === 'tool-next') toolActions.current?.next();
    if (action === 'zoom-close') {
      closeZoom();
      changeFocus('mission');
    }
    if (action === 'zoom-open') enterZoom();
    if (action === 'plan-open') enterPlan();
    if (action === 'tool-scroll') toolScroll.current?.();
    if (action === 'select-next') select(1);
    if (action === 'output' || action === 'diff') {
      pickTab(action === 'output' ? 1 : 2);
      changeFocus('mission');
    }
    if (action === 'menu') setMenu(current?.id ?? 'main');
    if (action === 'steer') prefill(current?.id ?? 'main');
    if (action === 'pause' && current) store.addNotice('main', controller.togglePause(current.id));
    if (action === 'cancel' && current) {
      if (cancel.current === current.id) {
        cancel.current = null;
        controller.cancelAgent(current.id);
      } else {
        cancel.current = current.id;
        store.setMeta({ toast: { text: `再按 x 取消 ${current.id} 及其子 agent`, tone: 'warn' } });
      }
    }
    if (action === 'tab-next') {
      const order = !layout.signals && !layout.narrow ? [0, 1, 2, 6, 3, 4, 5] : [0, 1, 2, 3, 4, 5];
      pickTab(order[(order.indexOf(tab) + 1) % order.length]!);
    }
    if (action === 'scroll' || action === 'page') move(action === 'scroll' ? 1 : Math.max(1, layout.body - 4));
    if (action === 'top')
      move(expanded ? (planZoom.active ? planLines.length : zoomRows.length) : focusRef.current === 'signals' ? signalMax : maxOffset);
    if (action === 'signal') {
      const target = regions.find((region) => region.target.kind === 'signal')?.target;
      if (target?.kind === 'signal') openSignal(target);
    }
  };
  useInput(
    (input) => {
      const events = parseMouse(input);
      if (!events.length || mouse === false) return;
      handleMouse.current(
        events,
        detail ? regions.filter((region) => region.target.kind === 'hint') : regions,
        {
          zoom,
          plan: enterPlan,
          planDetail: (target) => {
            if (target.kind === 'plan-member') {
              planZoom.exitToOutput();
              setSelected(target.agentId);
              pickTab(1);
            } else planZoom.close();
            changeFocus('mission');
          },
          output: (target) => {
            if (!zoom) enterZoom();
            else if (target.callId) openDetail(target.callId);
            else {
              setZoom(false);
              changeFocus('mission');
            }
          },
          focus: changeFocus,
          select: (id) => {
            if (tab === 0 && !expanded) {
              const next = missionLines(session, ui, tab, id, ascii, paneMetrics(layout.mission, layout.body).width);
              setOffset(Math.max(0, offset + next.length - raw.length));
            }
            setSelected(id);
            cancel.current = null;
          },
          tab: pickTab,
          menu: setMenu,
          scroll: (pane, delta) => {
            if (expanded) {
              scrollZoom(delta);
              return;
            }
            if (pane === 'colony') setColonyOffset((value) => Math.max(0, Math.min(colonyMax, value + delta)));
            else if (pane === 'signals') setSignalOffset((value) => Math.max(0, Math.min(signalMax, value - delta)));
            else {
              nav.current.offset = Math.max(0, Math.min(maxOffset, nav.current.offset - delta));
              setOffset(nav.current.offset);
            }
          },
          mode: () => controller.cycleMode(),
          strategy: () => controller.runCommand('/strategy'),
          hint: runHint,
          signal: openSignal,
        },
        Boolean(card),
      );
    },
    { isActive: !splash && !ui.meta.overlay && !menu },
  );
  const menuAgent = agents.find((agent) => agent.id === menu);
  const cost = session.cost(),
    runningChildren = agents.filter((agent) => agent.parentId && ['queued', 'running', 'waiting', 'paused'].includes(agent.state)).length;
  const center = (
    <MissionPane
      session={session}
      ui={ui}
      tab={tab}
      selected={current?.id ?? 'main'}
      height={layout.body}
      width={layout.mission}
      focused={focus === 'mission'}
      offset={Math.min(offset, maxOffset)}
      outputRows={outputRows}
      narrow={layout.narrow}
      signals={!layout.signals && !layout.narrow}
    />
  );
  const header = `ROAST HIVE v${VERSION} · ${session.providerName}:${session.model} · ${path.basename(cwd)} ${branch ? `⎇ ${branch}` : ''} · ${phase}${mission ? ` #${mission.missionId.slice(1)} · ${mission.strategy} · ${mission.goal}` : ''}`;
  if (splash)
    return (
      <Ignition
        session={session}
        height={layout.height}
        columns={columns}
        onExit={exit}
        onDone={(text) => {
          if (text) {
            draft.seed = ui.meta.inputSeed.key;
            draft.state = editorReducer(draft.state ?? createEditor(history), { type: 'insert', text });
          }
          setSplash(false);
        }}
      />
    );
  return (
    <Box height={layout.height} width={columns} flexDirection="column" overflow="hidden">
      {layout.header ? (
        <Text bold color={theme.accent} wrap="truncate-end">
          {terminalText(header)}
        </Text>
      ) : null}
      {menuAgent && !card ? (
        <AgentMenu
          agent={menuAgent}
          height={layout.body + layout.input + layout.keybar}
          controller={controller}
          onClose={() => setMenu(null)}
          onAction={(action) => {
            setMenu(null);
            setSelected(menuAgent.id);
            if (action === 'steer') prefill(menuAgent.id);
            else if (action === 'pause') store.addNotice('main', controller.togglePause(menuAgent.id));
            else {
              pickTab(action === 'output' ? 1 : 2);
              changeFocus('mission');
            }
          }}
        />
      ) : ui.meta.overlay && !card ? (
        <Overlay
          deck
          kind={ui.meta.overlay}
          session={session}
          store={store}
          controller={controller}
          height={layout.body + layout.input + layout.keybar}
        />
      ) : (
        <>
          {layout.body ? (
            detail && !card ? (
              <Box height={layout.body} overflow="hidden">
                <ToolDetail
                  actions={toolActions}
                  scrollAction={toolScroll}
                  tools={tools}
                  callId={detailCall}
                  width={columns}
                  maxLines={layout.body}
                  active
                />
              </Box>
            ) : expanded ? (
              <ZoomPane
                title={
                  planZoom.active
                    ? '计划详情 · Enter / 双击展开 · Esc 返回'
                    : `${current?.id === 'main' ? 'queen' : current?.id} ${current?.role} · 输出 · ${selectedView?.running ? '运行中' : current?.parentId ? current.state : phase}`
                }
                rows={planZoom.active ? planLines : zoomRows}
                start={planZoom.active ? planZoom.start : zoomStart}
                count={zoomCount}
                height={layout.body}
                width={columns}
                padding={padding}
              />
            ) : layout.compact ? (
              <Text wrap="truncate-end">
                HIVE {runningChildren}/{session.config.swarm.maxAgents} · {phase}
              </Text>
            ) : (
              <Box height={layout.body} flexShrink={0}>
                {layout.colony > 0 ? (
                  <ColonyPane
                    agents={agents}
                    views={ui.agents}
                    selected={current?.id ?? 'main'}
                    height={layout.body}
                    width={layout.colony}
                    focused={focus === 'colony'}
                    offset={Math.min(colonyOffset, colonyMax)}
                  />
                ) : null}
                {layout.narrow && (narrow === 0 || focus === 'colony') ? (
                  <Pane
                    title="蜂群 计划 输出 改动 信号"
                    lines={colonyLines(agents, ui.agents, current?.id ?? 'main', ascii, hints === 'full')}
                    width={columns}
                    height={layout.body}
                    focused={focus === 'colony'}
                    offset={Math.min(colonyOffset, colonyMax)}
                    fromTop
                    singleLine
                  />
                ) : (
                  center
                )}
                {layout.signals > 0 ? (
                  <SignalsPane
                    session={session}
                    ui={ui}
                    height={layout.body}
                    width={layout.signals}
                    focused={focus === 'signals'}
                    offset={Math.min(signalOffset, signalMax)}
                  />
                ) : null}
              </Box>
            )
          ) : null}
          <Box height={layout.input} flexShrink={0} flexDirection="column" overflow="hidden">
            {card ? (
              <InteractionCard
                actions={approvalActions}
                key={card.id}
                request={card}
                maxHeight={layout.input}
                onInterrupt={() => controller.ctrlC('')}
                onRespond={(response) => controller.respond(card, response)}
              />
            ) : (
              <>
                {layout.input >= 2 ? (
                  <Box height={1}>
                    <Box flexGrow={1} overflow="hidden">
                      <QueueLine texts={ui.meta.queued} />
                    </Box>
                    <Text dimColor wrap="truncate-end">
                      {terminalText(chip)}
                    </Text>
                  </Box>
                ) : null}
                <InputBox
                  actions={inputActions}
                  key={ui.meta.inputSeed.key}
                  active={focus === 'input' && !detail}
                  acceptInput={(input) =>
                    input !== '\ue019' &&
                    input !== '\ue014' &&
                    focusRef.current === 'input' &&
                    !detail &&
                    !menu &&
                    !store.getState().meta.overlay &&
                    !store.getState().meta.interactions.length
                  }
                  placeholder={main.running ? '插话，或 @成员 发指示' : '输入目标'}
                  initialHistory={history}
                  initialText={ui.meta.inputSeed.screen && ui.meta.inputSeed.screen !== 'hive' ? '' : ui.meta.inputSeed.text}
                  initialState={
                    draft.seed === ui.meta.inputSeed.key || (ui.meta.inputSeed.screen && ui.meta.inputSeed.screen !== 'hive')
                      ? draft.state
                      : undefined
                  }
                  onStateChange={(state) => {
                    draft.seed = ui.meta.inputSeed.key;
                    draft.state = state;
                  }}
                  deps={deps}
                  maxHeight={layout.input - (layout.input >= 2 ? 1 : 0)}
                  onHelp={() => store.setMeta({ overlay: 'help' })}
                  onSubmit={(text, raw) => controller.submit(text, raw)}
                />
              </>
            )}
          </Box>
        </>
      )}
      {!ui.meta.overlay && !menu && layout.keybar ? <KeyBar items={hintItems} columns={columns} /> : null}
      {layout.status ? (
        <StatusLine
          mode={ui.meta.mode}
          model={`${session.providerName}:${session.model}`}
          contextPercent={ui.meta.contextPercent}
          total={main.totalUsage}
          last={main.lastUsage}
          running={main.running}
          elapsedMs={main.turnStartedAt ? now - main.turnStartedAt : 0}
          step={main.step}
          cost={cost === null ? null : formatCost(cost)}
          branch={branch}
          agents={runningChildren}
          toast={ui.meta.toast}
        />
      ) : null}
    </Box>
  );
}
