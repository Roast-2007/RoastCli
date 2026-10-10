import { useViewport } from './viewport.js';
/**
 * Ink 根组件（inline 模式）：
 * - <Static>：横幅 + 已定稿条目（用户消息、markdown 块、思考摘要、工具卡片、提示、回合小结），只渲染一次
 * - 活动区（高度受控）：思考行、流式 markdown 尾巴、运行中的工具、待办、交互卡片或输入框、状态栏
 * 运行时事件 → UI store（合批）→ useSyncExternalStore；输入框支持插话排队、/命令、!命令、#记忆、@文件。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Static, Text, useApp, useInput, useStdin } from 'ink';
import type { Session } from '../agent/session.js';
import { createUiStore, type UiStore } from './store/store.js';
import { createUiController, type UiController } from './controller.js';
import type { DisplayItem } from './store/reducer.js';
import { latestTool, toolsOf } from './tool-nav.js';
import { Markdown } from './markdown/Markdown.js';
import { ToolCard, ToolDetail } from './components/ToolCard.js';
import { formatCost, gitBranch } from './status-info.js';
import { AgentsPanel, Banner, StatusLine, TodoPanel, TurnSummary } from './components/Chrome.js';
import { InteractionCard } from './components/InteractionCard.js';
import { useSpinner } from './components/useSpinner.js';
import { InputBox } from './input/InputBox.js';
import { FileIndex } from './input/files.js';
import { loadHistory } from './input/history.js';
import { COMMANDS, skillCommands, mcpPromptCommands } from './commands.js';
import { pickTheme, ThemeContext, useTheme } from './theme.js';
import { createEditor, editorReducer, textOf, type EditorState } from './input/editor.js';
import { readClipboardImage } from '../core/clipboard.js';
import { QueueLine } from './hive/QueueLine.js';
import { inlineLayout } from './layout.js';
import { TerminalContext, terminalPreferences, useGlyphs } from './terminal.js';
import { Overlay } from './components/Overlay.js';
import { terminalText } from '../core/terminal-text.js';
import { FullScreen } from './FullScreen.js';

function clipTail(text: string, maxLines: number): string {
  const lines = text.split('\n');
  return lines.length > maxLines ? lines.slice(-maxLines).join('\n') : text;
}

type StaticEntry = { id: number; kind: 'banner' } | DisplayItem;

function Item({ item, session, columns }: { item: StaticEntry; session: Session; columns: number }) {
  const theme = useTheme();
  const glyph = useGlyphs();
  const toneIcon = { info: glyph.info, warn: glyph.warning, error: glyph.error, success: glyph.ok };
  switch (item.kind) {
    case 'banner': {
      return (
        <Banner
          model={`${session.providerName}:${session.model}`}
          cwd={session.log.header.cwd}
          {...(session.resumedFrom
            ? { resumed: `已恢复会话 ${session.resumedFrom.runId}（${session.resumedFrom.messageCount} 条消息）` }
            : {})}
          warnings={session.startupWarnings}
        />
      );
    }
    case 'mission':
      return (
        <Text>
          ⬡ 任务 #{item.missionId.slice(1)} · {item.strategy} · {item.goal}
        </Text>
      );
    case 'user':
      return (
        <Box marginTop={1}>
          <Text color={theme.user} bold>
            {glyph.pointer}{' '}
          </Text>
          <Text>{terminalText(item.text)}</Text>
        </Box>
      );
    case 'markdown':
      return (
        <Box flexDirection="column">
          <Markdown text={item.text} preferences={session.config.ui?.markdown} columns={columns} />
          {item.partial ? <Text dimColor>（已中断，未发送给模型）</Text> : null}
        </Box>
      );
    case 'reasoning':
      return (
        <Text dimColor italic>
          {glyph.thinking} {terminalText(item.text).split('\n').slice(0, 3).join(' ').slice(0, 200)}
          {item.text.length > 200 ? '…' : ''}
        </Text>
      );
    case 'tool':
      return <ToolCard tool={item.tool} />;
    case 'tool-group':
      return (
        <Text wrap="truncate-end" color={theme.tool}>
          {glyph.ok} {item.tools[0]?.name} ×{item.tools.length}{' '}
          <Text dimColor>
            {item.tools
              .map((tool) => terminalText(String((tool.args as { path?: string } | undefined)?.path ?? '')))
              .filter(Boolean)
              .join(' · ')}
          </Text>
        </Text>
      );
    case 'notice':
      if (item.quiet) return null;
      return (
        <Text
          color={
            item.tone === 'error' ? theme.danger : item.tone === 'warn' ? theme.warn : item.tone === 'success' ? theme.success : theme.info
          }
        >
          {toneIcon[item.tone]} {terminalText(item.text)}
        </Text>
      );
    case 'turn-summary':
      return <TurnSummary durationMs={item.durationMs} usage={item.usage} reason={item.reason} />;
  }
}

function Thinking({ label }: { label: string }) {
  const theme = useTheme();
  const frame = useSpinner(true);
  return (
    <Text color={theme.accent}>
      {frame} <Text dimColor>{label}</Text>
    </Text>
  );
}

export interface AppProps {
  session: Session;
  /** Fixed-height alternate-screen workspace; inline remains available to embedders. */
  fullScreen?: boolean;
  /** Play once on first interactive mount, never on screen handoffs. */
  startup?: boolean;
  /** 外部创建的 store / 控制器（CLI 用，跨屏幕切换保留）；缺省时组件内部创建（测试用） */
  store?: UiStore;
  controller?: UiController;
  initialPrompt?: import('../agent/runtime.js').RuntimeInput;
  /** 重新挂载时，已经打印到终端 scrollback 的最后一个条目 id（Static 只输出之后的条目，不重复打印） */
  printedUpTo?: number;
  /** Ctrl+G：请求进入 Mission Control（由 CLI 负责屏幕交接） */
  onMissionControl?: () => void;
  inputDraft?: { seed?: number; state?: EditorState };
}

export function App(props: AppProps) {
  return props.fullScreen ? <FullScreen {...props} /> : <Shell {...props} />;
}

/** 两次 Esc 的判定间隔 */
const DOUBLE_ESC_MS = 600;

/**
 * 全局按键：Shift+Tab 切换模式 · Esc 中断（空闲时连按两次打开回退列表）· Ctrl+O 工具输出详情 ·
 * Ctrl+G Mission Control · Ctrl+C 中断 / 退出
 */
function useShellKeys(opts: {
  controller: UiController;
  onCtrlC(): void;
  active: boolean;
  onToggleDetail(): void;
  onDetailEscape?: () => void;
  onMissionControl?: () => void;
  onHelp(): void;
}) {
  const lastEsc = useRef(0);
  const { stdin } = useStdin();
  useEffect(() => {
    if (!opts.active) return;
    const onData = (data: Buffer | string) => {
      if (['\u001bOP', '\u001b[11~', '\u001b[57364u'].includes(data.toString())) opts.onHelp();
    };
    stdin.on('data', onData);
    return () => {
      stdin.off('data', onData);
    };
  }, [stdin, opts.active, opts.onHelp]);
  useInput(
    (ch, key) => {
      const { controller } = opts;
      if (key.tab && key.shift) return controller.cycleMode();
      if (key.escape) {
        if (opts.onDetailEscape) return opts.onDetailEscape();
        if (controller.isRunning()) return controller.interrupt();
        const now = Date.now();
        if (now - lastEsc.current < DOUBLE_ESC_MS) {
          lastEsc.current = 0;
          return controller.runCommand('/rewind');
        }
        lastEsc.current = now;
        return;
      }
      if (key.ctrl && ch === 'o') return opts.onToggleDetail();
      if (key.ctrl && ch === 'g' && opts.onMissionControl) return opts.onMissionControl();
      if (key.ctrl && ch === 'c') return opts.onCtrlC();
    },
    { isActive: opts.active },
  );
}

function Shell({
  session,
  store: externalStore,
  controller: externalController,
  initialPrompt,
  printedUpTo,
  onMissionControl,
  inputDraft,
}: AppProps) {
  const { exit } = useApp();
  const { rows, columns } = useViewport(session.config.ui?.gutter);
  const cwd = session.log.header.cwd;
  const localDraft = useRef<{ seed?: number; state?: EditorState }>({});
  const draft = inputDraft ?? localDraft.current;
  const store = useMemo(() => externalStore ?? createUiStore(), [externalStore]);
  const controller = useMemo(
    () => externalController ?? createUiController(session, store, { exit }),
    [externalController, session, store, exit],
  );
  useEffect(() => (externalController ? undefined : () => controller.dispose()), [controller, externalController]);
  const ui = useSyncExternalStore(store.subscribe, store.getState);
  const view = ui.agents['main']!;
  const meta = ui.meta;
  const theme = pickTheme(process.env, meta.theme ?? session.config.ui?.theme);
  const terminal = useMemo(() => terminalPreferences(process.env, session.config.ui), [session]);
  const files = useMemo(() => new FileIndex(cwd), [cwd]);
  const history = useMemo(() => loadHistory(cwd), [cwd]);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!view.running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [view.running]);

  const card = meta.interactions[0];
  const [detail, setDetail] = useState(false),
    [detailCall, setDetailCall] = useState<string>();
  useShellKeys({
    controller,
    onCtrlC: () => {
      if (controller.ctrlC(draft.state ? textOf(draft.state) : '') === 'clear') {
        draft.state = editorReducer(draft.state ?? createEditor(history), { type: 'set', text: '' });
        store.setMeta((m) => ({ inputSeed: { key: m.inputSeed.key + 1, text: '', screen: 'inline' } }));
        draft.seed = store.getState().meta.inputSeed.key;
      }
    },
    active: card === undefined && meta.overlay === null,
    onToggleDetail: () => {
      if (!detail) setDetailCall(latestTool(view)?.callId);
      setDetail((d) => !d);
    },
    ...(detail ? { onDetailEscape: () => setDetail(false) } : {}),
    onHelp: () => store.setMeta({ overlay: 'help' }),
    ...(onMissionControl ? { onMissionControl } : {}),
  });

  // roast swarm：启动后自动提交目标（只执行一次）
  const autoSubmitted = useRef(false);
  useEffect(() => {
    if (!initialPrompt || autoSubmitted.current) return;
    autoSubmitted.current = true;
    controller.submit(initialPrompt, typeof initialPrompt === 'string' ? initialPrompt : 'kind' in initialPrompt ? initialPrompt.goal : '');
  }, [initialPrompt, controller]);

  const activity = useCallback(
    (id: string) => {
      const v = ui.agents[id];
      const tool = v?.tools[0];
      return tool ? tool.name : v?.reasoning ? '思考中' : v?.pending ? '输出中' : '运行中';
    },
    [ui],
  );

  const layout = inlineLayout(rows, {
    tools: view.tools.length,
    todos: view.todos.length,
    agents: meta.swarm.length - 1,
    interaction: Boolean(card),
    detail,
  });
  const toolsShown = Math.min(view.tools.length, Math.max(0, Math.min(rows >= 40 ? 3 : 1, layout.tools)));
  const toolHeight = Math.max(1, Math.floor((layout.tools - (view.tools.length > toolsShown ? 1 : 0)) / Math.max(1, toolsShown)));
  const elapsed = view.turnStartedAt ? now - view.turnStartedAt : 0;
  const deps = useMemo(
    () => ({
      commands: [...COMMANDS, ...skillCommands(session.skills.list()), ...mcpPromptCommands(session)],
      files: (q: string) => files.match(q),
    }),
    [files, session],
  );
  // 分支在每个回合开始 / 结束时重新读取（模型可能切换了分支）
  const branch = useMemo(() => gitBranch(cwd), [cwd, view.running]);
  const cost = session.cost();
  const staticItems: StaticEntry[] =
    printedUpTo === undefined ? [{ id: 0, kind: 'banner' }, ...view.items] : view.items.filter((i) => i.id > printedUpTo);

  return (
    <ThemeContext.Provider value={theme}>
      <TerminalContext.Provider value={terminal}>
        <Box flexDirection="column">
          <Static items={staticItems}>{(item) => <Item key={item.id} item={item} session={session} columns={columns} />}</Static>
          <Box flexDirection="column" maxHeight={Math.max(1, rows)} overflow="hidden">
            {meta.overlay && !card ? (
              <Overlay
                key={meta.overlay}
                kind={meta.overlay}
                session={session}
                store={store}
                controller={controller}
                height={Math.max(1, rows - 2)}
              />
            ) : (
              <>
                {layout.stream > 0 && (view.running || view.pending || view.reasoning) ? (
                  <Box flexDirection="column" maxHeight={layout.stream} overflow="hidden" flexShrink={0}>
                    {view.reasoning ? <Thinking label={`思考中… ${view.reasoning.length} 字`} /> : null}
                    {view.pending ? (
                      <Markdown
                        text={clipTail(view.pending, Math.max(1, layout.stream - 3))}
                        preferences={session.config.ui?.markdown}
                        compact
                        columns={columns}
                      />
                    ) : null}
                    {view.running && !view.pending && !view.reasoning && view.tools.length === 0 ? <Thinking label="思考中…" /> : null}
                  </Box>
                ) : null}
                {layout.tools > 0 ? (
                  <Box flexDirection="column" maxHeight={layout.tools} overflow="hidden" flexShrink={0}>
                    {view.tools.slice(0, toolsShown).map((t) => (
                      <ToolCard key={t.callId} tool={t} maxHeight={toolHeight} />
                    ))}
                    {view.tools.length > toolsShown ? (
                      <Text dimColor wrap="truncate-end">
                        +{view.tools.length - toolsShown} 个工具运行中
                      </Text>
                    ) : null}
                  </Box>
                ) : null}
                <AgentsPanel agents={meta.swarm} activity={activity} maxHeight={layout.agents} />
                <TodoPanel todos={view.todos} maxHeight={layout.todos} />
                {detail && layout.detail > 0 ? (
                  <Box maxHeight={layout.detail} overflow="hidden" flexShrink={0}>
                    <ToolDetail tools={toolsOf(view)} callId={detailCall} maxLines={layout.detail} active={!card} />
                  </Box>
                ) : null}
                {card ? (
                  <InteractionCard
                    key={card.id}
                    request={card}
                    maxHeight={layout.interaction}
                    onInterrupt={() => controller.ctrlC('')}
                    onRespond={(r) => controller.respond(card, r)}
                    onShown={() => controller.showInteraction(card.id)}
                    onHold={() => controller.holdInteraction(card.id)}
                  />
                ) : layout.input > 0 ? (
                  <Box height={layout.input} flexDirection="column" overflow="hidden">
                    <QueueLine texts={meta.queued} />
                    <InputBox
                      key={meta.inputSeed.key}
                      active={!detail}
                      maxHeight={Math.max(1, layout.input - (meta.queued.length ? 1 : 0))}
                      onHelp={() => store.setMeta({ overlay: 'help' })}
                      placeholder={view.running ? '插话' : '输入消息'}
                      initialHistory={history}
                      initialText={meta.inputSeed.text}
                      initialState={draft.seed === meta.inputSeed.key ? draft.state : undefined}
                      onStateChange={(state) => {
                        draft.seed = meta.inputSeed.key;
                        draft.state = state;
                      }}
                      deps={deps}
                      attachments={{ cwd: session.log.header.cwd, readClipboard: readClipboardImage, notify: controller.notify }}
                      onSubmit={(text, raw, images) => controller.submit(text, raw, images)}
                    />
                  </Box>
                ) : null}
              </>
            )}
            {layout.status > 0 ? (
              <StatusLine
                mode={meta.mode}
                model={`${session.providerName}:${session.model}`}
                contextPercent={meta.contextPercent}
                total={view.totalUsage}
                last={view.lastUsage}
                running={view.running}
                elapsedMs={elapsed}
                step={view.step}
                branch={branch}
                cost={cost !== null ? formatCost(cost) : null}
                toast={meta.toast}
                agents={
                  meta.swarm.filter((agent) => agent.parentId && ['queued', 'running', 'waiting', 'paused'].includes(agent.state)).length
                }
              />
            ) : null}
          </Box>
        </Box>
      </TerminalContext.Provider>
    </ThemeContext.Provider>
  );
}
