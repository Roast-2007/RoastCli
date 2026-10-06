import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Text, useApp, useInput, useStdin, useWindowSize } from 'ink';
import type { AppProps } from './App.js';
import { createUiStore } from './store/store.js';
import { createUiController } from './controller.js';
import { ThemeContext, pickTheme, useTheme } from './theme.js';
import { TerminalContext, terminalPreferences, useTerminal } from './terminal.js';
import { fullscreenLayout } from './layout.js';
import { createTranscript } from './transcript.js';
import { useScroll } from './scroll.js';
import { mouseWheel, useMouseReporting } from './mouse.js';
import { motionColor, useEntrance } from './motion.js';
import { VERSION } from '../core/version.js';
import { terminalText } from '../core/terminal-text.js';
import { truncateDisplay } from '../core/text-width.js';
import { COMMANDS, skillCommands, mcpPromptCommands } from './commands.js';
import { FileIndex } from './input/files.js';
import { loadHistory } from './input/history.js';
import { createEditor, editorReducer, type EditorState } from './input/editor.js';
import { InputBox } from './input/InputBox.js';
import { Overlay } from './components/Overlay.js';
import { Startup, ROAST_LOGO } from './components/Startup.js';
import { AgentsPanel, StatusLine, TodoPanel } from './components/Chrome.js';
import { InteractionCard } from './components/InteractionCard.js';
import { ToolDetail } from './components/ToolCard.js';
import { formatCost, gitBranch } from './status-info.js';
import { useSpinner } from './components/useSpinner.js';

export function FullScreen(props: AppProps) {
  const { exit } = useApp();
  const store = useMemo(() => props.store ?? createUiStore(), [props.store]);
  const controller = useMemo(() => props.controller ?? createUiController(props.session, store, { exit }), [props.controller, props.session, store, exit]);
  useEffect(() => props.controller ? undefined : () => controller.dispose(), [controller, props.controller]);
  const ui = useSyncExternalStore(store.subscribe, store.getState);
  const theme = pickTheme(process.env, ui.meta.theme ?? props.session.config.ui?.theme);
  const terminal = useMemo(() => terminalPreferences(process.env, props.session.config.ui), [props.session]);
  return <ThemeContext.Provider value={theme}><TerminalContext.Provider value={terminal}><Workspace {...props} store={store} controller={controller} /></TerminalContext.Provider></ThemeContext.Provider>;
}

function Workspace({ session, store: storeProp, controller: controllerProp, inputDraft, initialPrompt, printedUpTo = 0, onMissionControl, startup }: AppProps) {
  const store = storeProp!, controller = controllerProp!;
  const { exit } = useApp(), { stdin } = useStdin(), { rows, columns } = useWindowSize();
  const theme = useTheme(), { ascii, motion } = useTerminal();
  const ui = useSyncExternalStore(store.subscribe, store.getState), view = ui.agents.main!, meta = ui.meta;
  const localDraft = useRef<{ seed?: number; state?: EditorState }>({});
  const draft = inputDraft ?? localDraft.current;
  const [splash, setSplash] = useState(Boolean(startup && motion && !initialPrompt));
  useMouseReporting();
  const [detail, setDetail] = useState(false), [reading, setReading] = useState(false);
  const readingRef = useRef(false), detailRef = useRef(false), lastEsc = useRef(0);
  const escHint = useRef(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!view.running) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [view.running]);
  const cwd = session.log.header.cwd;
  const history = useMemo(() => loadHistory(cwd), [cwd]), files = useMemo(() => new FileIndex(cwd), [cwd]);
  const deps = useMemo(() => ({ commands: [...COMMANDS, ...skillCommands(session.skills.list()), ...mcpPromptCommands(session)], files: (q: string) => files.match(q) }), [session, files]);
  const branch = useMemo(() => gitBranch(cwd), [cwd, view.running]);
  const card = meta.interactions[0];
  const layout = fullscreenLayout(rows, { interaction: Boolean(card), detail, todos: view.todos.some((t) => t.status !== 'completed'), agents: meta.swarm.some((a) => a.parentId && ['queued', 'running', 'waiting', 'paused'].includes(a.state)) });
  const padding = Math.min(session.config.ui?.markdown?.padding ?? (columns >= 60 ? 2 : columns >= 30 ? 1 : 0), Math.max(0, Math.floor((columns - 12) / 2)));
  const width = Math.max(1, columns - padding * 2);
  const transcript = useMemo(createTranscript, []);
  const transcriptRows = useMemo(() => transcript(view, width, ascii, session.config.ui?.markdown?.spacing ?? 1, printedUpTo), [transcript, view, width, ascii, session, printedUpTo]);
  const count = Math.max(1, layout.body), scroll = useScroll(transcriptRows.length, count);
  const start = reading ? scroll.start : scroll.max;
  const ready = !splash && !card && !meta.overlay;
  const leaveReading = () => { readingRef.current = false; setReading(false); };
  const read = () => { readingRef.current = true; setReading(true); };
  const autoSubmitted = useRef(false);
  useEffect(() => { if (!splash && initialPrompt && !autoSubmitted.current) { autoSubmitted.current = true; controller.submit(initialPrompt, typeof initialPrompt === 'string' ? initialPrompt : 'kind' in initialPrompt ? initialPrompt.goal : ''); } }, [splash, initialPrompt, controller]);
  useEffect(() => {
    if (!ready) return;
    const help = (data: Buffer | string) => { if (['\u001bOP', '\u001b[11~', '\u001b[57364u'].includes(data.toString())) store.setMeta({ overlay: 'help' }); };
    stdin.on('data', help); return () => { stdin.off('data', help); };
  }, [ready, stdin, store]);
  useInput((input, key) => {
    const wheel = mouseWheel(input);
    if (wheel !== null) {
      if (detailRef.current || wheel === 0) return;
      const next = Math.max(0, Math.min(scroll.max, (readingRef.current ? scroll.position() : scroll.max) + wheel));
      scroll.move(next);
      if (next === scroll.max) leaveReading(); else read();
      return;
    }
    if (key.ctrl && input === 'c') return controller.isRunning() ? controller.interrupt() : exit();
    if (key.tab && key.shift) return controller.cycleMode();
    if (key.ctrl && input === 'g') return onMissionControl?.();
    if (key.ctrl && input === 'o') { leaveReading(); detailRef.current = !detailRef.current; setDetail(detailRef.current); return; }
    if (detailRef.current) { if (key.escape) { detailRef.current = false; setDetail(false); } return; }
    if (key.escape) {
      if (readingRef.current) return leaveReading();
      if (controller.isRunning()) return controller.interrupt();
      const time = Date.now();
      if (time - lastEsc.current < 600) { lastEsc.current = 0; return controller.runCommand('/rewind'); }
      lastEsc.current = time;
      if (!escHint.current) { escHint.current = true; store.addNotice('main', '再次按 Esc 可打开回退菜单（文件与对话）'); }
      return;
    }
    if (key.pageUp || ((key.shift || key.ctrl) && key.upArrow)) {
      if (!readingRef.current) { scroll.move(Math.max(0, scroll.max - (key.pageUp ? Math.max(1, count - 1) : 1))); read(); }
      else scroll.onKey('', key);
      return;
    }
    if (key.pageDown || ((key.shift || key.ctrl) && key.downArrow)) { if (readingRef.current) scroll.onKey('', key); return; }
    if (readingRef.current) {
      if (key.return || key.end || input === 'G') return leaveReading();
      if (input === '?') return store.setMeta({ overlay: 'help' });
      scroll.onKey(input, key);
    }
  }, { isActive: ready });
  const accent = motionColor(theme.border, theme.accent, useEntrance(meta.overlay ?? (detail ? 'detail' : card?.id ?? 'conversation')));
  const spinner = useSpinner(view.running && !splash);
  const cost = session.cost();
  const tool = useMemo(() => {
    if (view.tools[0]) return view.tools[0];
    for (let index = view.items.length - 1; index >= 0; index--) {
      const item = view.items[index]!;
      if (item.kind === 'tool') return item.tool;
      if (item.kind === 'tool-group') return item.tools.at(-1);
    }
    return undefined;
  }, [view.tools, view.items]);

  if (splash) return <Startup height={layout.height} columns={columns} onExit={exit} onDone={(text) => {
    if (text) { draft.seed = meta.inputSeed.key; draft.state = editorReducer(draft.state ?? createEditor(history), { type: 'insert', text }); }
    setSplash(false);
  }} />;
  return <Box height={layout.height} width={columns} flexDirection="column" overflow="hidden">
    {layout.header ? <Box height={layout.header} flexDirection="column" flexShrink={0} paddingX={columns >= 40 ? 1 : 0}>
      <Text bold color={accent} wrap="truncate-end">{truncateDisplay(`R O A S T  v${VERSION} · ${session.providerName}:${session.model}${session.resumedFrom ? ' · 已恢复' : ''}`, columns - (columns >= 40 ? 2 : 0))}</Text>
      {layout.header > 1 ? <Text dimColor wrap="truncate-middle">{terminalText(cwd)}</Text> : null}
    </Box> : null}
    {meta.overlay && !card ? <Overlay key={meta.overlay} kind={meta.overlay} session={session} store={store} controller={controller} height={layout.height - layout.header - layout.status} /> : <>
      <Box height={layout.body} flexShrink={0} flexDirection="column" overflow="hidden" paddingX={padding}>
        {detail && !card ? <ToolDetail key={tool?.callId} tool={tool} maxLines={layout.body} width={width} active={ready} /> : transcriptRows.length ? transcriptRows.slice(start, start + count).map((row, index) => <Text key={index} wrap="truncate-end">{row.length ? row.map((span, i) => <Text key={i} color={span.color ? theme[span.color] as string | undefined : undefined} bold={span.bold} dimColor={span.dim} italic={span.italic} underline={span.underline} strikethrough={span.strike}>{span.text}</Text>) : ' '}</Text>) : <Welcome height={layout.body} columns={width} warnings={session.startupWarnings} />}
      </Box>
      {layout.agents ? <AgentsPanel agents={meta.swarm} activity={(id) => ui.agents[id]?.tools[0]?.name ?? '运行中'} maxHeight={layout.agents} /> : null}
      {layout.todos ? <TodoPanel todos={view.todos} maxHeight={layout.todos} /> : null}
      {layout.hint ? <Text color={reading ? theme.info : theme.muted} wrap="truncate-end">{detail ? '工具详情 · ↑↓ 滚动 · Ctrl+O 返回' : reading ? `阅读 · ${start + 1}–${Math.min(transcriptRows.length, start + count)}/${transcriptRows.length} · ↑↓ 滚动 · End/Enter/Esc 返回输入` : view.running ? `${spinner} 运行中 · Shift+↑↓ 滚动 · Esc 中断 · Enter 排队插话` : 'Shift+↑↓ / PgUp 阅读 · ? 帮助 · Ctrl+G Hive'}</Text> : null}
      <Box height={layout.input} flexShrink={0} overflow="hidden" flexDirection="column">
        {card ? <InteractionCard key={card.id} request={card} maxHeight={layout.input} onRespond={(response) => controller.respond(card, response)} /> : <InputBox key={meta.inputSeed.key} active={ready && !reading && !detail} maxHeight={layout.input} acceptInput={() => !readingRef.current && !detailRef.current && !store.getState().meta.overlay && store.getState().meta.interactions.length === 0} placeholder={reading ? '阅读中 · Enter / Esc 返回输入' : view.running ? '运行中…回车可排队插话' : '输入消息 · /命令 · @文件 · !shell · #记忆'} initialHistory={history} initialText={meta.inputSeed.text} initialState={draft.seed === meta.inputSeed.key ? draft.state : undefined} onStateChange={(state) => { draft.seed = meta.inputSeed.key; draft.state = state; }} deps={deps} onHelp={() => store.setMeta({ overlay: 'help' })} onSubmit={(text, raw) => { leaveReading(); controller.submit(text, raw); }} />}
      </Box>
    </>}
    {layout.status ? <StatusLine mode={meta.mode} model={`${session.providerName}:${session.model}`} contextPercent={meta.contextPercent} total={view.totalUsage} last={view.lastUsage} running={view.running} elapsedMs={view.turnStartedAt ? now - view.turnStartedAt : 0} step={view.step} branch={branch} cost={cost === null ? null : formatCost(cost)} toast={meta.toast} agents={meta.swarm.filter((a) => a.parentId && ['queued', 'running', 'waiting', 'paused'].includes(a.state)).length} /> : null}
  </Box>;
}

function Welcome({ height, columns, warnings }: { height: number; columns: number; warnings: string[] }) {
  const theme = useTheme();
  const logo = height >= 12 && columns >= 34 ? ROAST_LOGO : ['R O A S T'];
  return <Box height={height} flexDirection="column" justifyContent="center" overflow="hidden">
    {logo.map((line, index) => <Text key={index} color={theme.accent} bold wrap="truncate-end">{truncateDisplay(line, columns)}</Text>)}
    {height > logo.length + 1 ? <Text dimColor wrap="truncate-end">{truncateDisplay('开始一个任务，或输入 / 查看命令', columns)}</Text> : null}
    {warnings.slice(0, Math.max(0, height - logo.length - 2)).map((warning, index) => <Text key={index} color={theme.warn} wrap="truncate-end">{terminalText(warning)}</Text>)}
  </Box>;
}
