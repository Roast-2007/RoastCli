/**
 * UI 控制器：界面行为的唯一实现（与 React 组件树解耦）。
 * - 驱动主会话 turn、处理输入（/命令、!shell、#记忆、插话排队）、中断
 * - 订阅 broker / 权限模式 / 蜂群树 / 消息总线 / 子 agent 事件，写入 store
 * 对话与 Mission Control 共用一个全屏渲染器；切换视图不影响进行中的 turn。
 */
import type { Session } from '../agent/session.js';
import type { InteractionRequest, InteractionResponse } from '../core/interaction.js';
import { runForeground } from '../tools/bash/run.js';
import { appendMemory, runSlash, skillPrompt } from './commands.js';
import { appendHistory } from './input/history.js';
import type { UiStore } from './store/store.js';
import { emptyUsage } from '../core/types.js';

const TIMELINE_MAX = 50;

export interface UiController {
  submit(text: string, raw: string): void;
  interrupt(): void;
  respond(req: InteractionRequest, response: InteractionResponse): void;
  cycleMode(): void;
  /** 执行一条斜杠命令（不写入输入历史），如 Esc Esc 打开回退列表 */
  runCommand(text: string): void;
  /** 给某个 agent 发 steer（用户经 main 转达） */
  steerAgent(agentId: string, text: string): string;
  cancelAgent(agentId: string): void;
  togglePause(agentId: string): string;
  setScreen(screen: 'inline' | 'mission' | 'providers'): void;
  isRunning(): boolean;
  whenIdle(): Promise<void>;
  resumeSession(logPath: string): void;
  dispose(): void;
}

export function createUiController(session: Session, store: UiStore, opts: { exit(): void; openProviders?(): void; clearScreen?(): void; openSession?(logPath: string): void }): UiController {
  const cwd = session.log.header.cwd;
  let abort: AbortController | null = null;
  let running = false;
  let pending: Promise<void> = Promise.resolve();
  let shellRunning = false;
  const offs: (() => void)[] = [];
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const toast = (text: string, tone: 'info' | 'success' = 'info') => {
    clearTimeout(toastTimer);
    store.setMeta({ toast: { text, tone } });
    toastTimer = setTimeout(() => { toastTimer = undefined; store.setMeta({ toast: null }); }, 3000);
    toastTimer.unref?.();
  };
  if (session.resumedFrom && store.getState().agents['main']!.items.length === 0) store.restore('main', session.initialEvents);

  store.setMeta({ mode: session.permissions.mode, contextPercent: session.contextStats().percent, swarm: session.swarm.tree(), interactions: session.broker.pending() });
  const refreshInteractions = () => store.setMeta({ interactions: session.broker.pending() });
  offs.push(session.broker.onRequest(refreshInteractions));
  offs.push(session.broker.onChange(refreshInteractions));
  offs.push(session.permissions.onModeChange((mode) => { store.setMeta({ mode }); toast(`权限模式：${mode}`); }));
  offs.push(session.onAgentEvent((id, ev) => store.pushEvent(id, ev)));
  offs.push(
    session.swarm.onMessage((e) =>
      store.setMeta((m) => (m.messages.some((x) => x.id === e.id) ? {} : { messages: [...m.messages, e].slice(-TIMELINE_MAX) })),
    ),
  );
  let swarmTimer: ReturnType<typeof setTimeout> | null = null;
  offs.push(
    session.onSwarmChange(() => {
      swarmTimer ??= setTimeout(() => {
        swarmTimer = null;
        store.setMeta({ swarm: session.swarm.tree() });
      }, 100);
    }),
  );

  const pruneInteractions = () => {
    const live = new Set(session.broker.pending().map((r) => r.id));
    store.setMeta((m) => ({ interactions: m.interactions.filter((r) => live.has(r.id)) }));
  };

  async function runTurn(text: string): Promise<void> {
    running = true;
    store.setMeta({ running: true });
    const controller = new AbortController();
    abort = controller;
    try {
      for await (const ev of session.loop.run(text, controller.signal)) {
        store.pushEvent('main', ev);
        if (ev.type === 'queue-restored') store.setMeta((m) => ({ inputSeed: { key: m.inputSeed.key + 1, text: ev.texts.join('\n') } }));
        if (ev.type === 'usage' || ev.type === 'turn-end') store.setMeta({ contextPercent: session.contextStats().percent });
        if (ev.type === 'turn-end') pruneInteractions();
      }
    } catch (err) {
      store.addNotice('main', `运行出错：${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      running = false;
      abort = null;
      store.setMeta({ running: false });
    }
  }

  async function runShell(command: string): Promise<void> {
    if (!command.trim()) { store.addNotice('main', '! 后请输入命令', 'warn'); return; }
    if (running) { store.addNotice('main', '请等当前任务结束后执行 shell 命令', 'warn'); store.setMeta((m) => ({ inputSeed: { key: m.inputSeed.key + 1, text: `!${command}` } })); return; }
    running = true; shellRunning = true;
    const controller = new AbortController(); abort = controller;
    const callId = `shell-${Date.now()}`;
    const start = Date.now();
    store.addUser('main', `!${command}`);
    store.setMeta({ running: true });
    store.pushEvent('main', { type: 'turn-start', turn: 0 });
    store.pushEvent('main', { type: 'tool-call-start', callId, name: 'bash', args: { command } });
    let aborted = false;
    try {
      const r = await runForeground({ command, cwd, timeoutMs: 120_000, signal: controller.signal, onOutput: (text) => store.pushEvent('main', { type: 'tool-progress', callId, text }) });
      const out = 'output' in r ? r.output.trim() : r.message;
      aborted = r.kind === 'aborted';
      if (!aborted) store.pushEvent('main', { type: 'tool-call-end', callId, name: 'bash', isError: r.kind !== 'exited' || r.code !== 0, output: out.slice(-8000), preview: out.slice(-800), durationMs: Date.now() - start });
      const code = r.kind === 'exited' ? ` · exit ${r.code}` : r.kind === 'timeout' ? ' · 超时' : aborted ? ' · 已中断' : '';
      store.addNotice('main', `${out.slice(-8000) || '（无输出）'}\n[未发送给模型${code}]`, r.kind === 'exited' && r.code === 0 ? 'info' : 'warn');
    } catch (err) { store.addNotice('main', `shell 出错：${err instanceof Error ? err.message : String(err)}`, 'error'); aborted = true; }
    finally {
      store.pushEvent('main', { type: 'turn-end', reason: aborted ? 'aborted' : 'completed', usage: emptyUsage() });
      running = false; shellRunning = false; abort = null; store.setMeta({ running: false });
    }
  }

  function send(text: string): void {
    if (shellRunning) {
      store.setMeta((m) => ({ inputSeed: { key: m.inputSeed.key + 1, text } }));
      store.addNotice('main', 'shell 正在执行，消息已保留在输入框；结束后可发送', 'info');
      return;
    }
    if (running && session.loop.enqueue(text)) return store.addNotice('main', `⏳ 已排队，将在下一步送达：${text}`, 'info');
    store.addUser('main', text);
    pending = runTurn(text);
  }

  /** 内置命令优先；否则同名技能 → 作为一条用户消息交给模型 */
  async function slash(text: string): Promise<void> {
    if (await runSlash(text, { session, store, exit: opts.exit, send, openProviders: opts.openProviders, clearScreen: opts.clearScreen, resumeSession, openOverlay: (overlay) => store.setMeta({ overlay }) })) return;
    const [head = '', ...rest] = text.slice(1).split(' ');
    if (session.skills.get(head)) return send(skillPrompt(head, rest.join(' ').trim()));
    store.addNotice('main', `未知命令：/${head}（/help 查看全部）`, 'warn');
  }

  function resumeSession(logPath: string): void {
    if (running || session.swarm.tree().some((a) => a.parentId && ['running', 'waiting', 'paused', 'queued'].includes(a.state))) return store.addNotice('main', '请等当前会话和子 agent 空闲后恢复另一场会话', 'warn');
    if (opts.openSession) opts.openSession(logPath);
    else store.addNotice('main', `可用 roast -r 恢复会话：${logPath}`, 'info');
  }
  return {
    submit(text, raw) {
      appendHistory(cwd, raw);
      if (text.startsWith('/')) return void slash(text);
      if (text.startsWith('!')) { if (running) { void runShell(text.slice(1).trim()); return; } pending = runShell(text.slice(1).trim()); return; }
      if (text.startsWith('#')) {
        try {
          if (!text.slice(1).trim()) return store.addNotice('main', '# 后请输入要记住的内容', 'warn');
          const file = appendMemory(cwd, text.slice(1));
          return store.addNotice('main', `已记住，写入 ${file}（下次会话生效）`, 'success');
        } catch (err) { return store.addNotice('main', `保存记忆失败：${err instanceof Error ? err.message : String(err)}`, 'error'); }
      }
      send(text);
    },
    interrupt() {
      if (running) abort?.abort();
    },
    respond(req, response) {
      if (session.broker.respond(req.id, response)) toast('已提交回答', 'success');
    },
    cycleMode() {
      session.permissions.cycleMode();
    },
    runCommand(text) {
      void slash(text);
    },
    steerAgent(agentId, text) {
      if (agentId === 'main') { send(text); return '已发送给主会话'; }
      const r = session.swarm.bus.send('main', { to: { agent: agentId }, kind: 'steer', subject: '用户指示', body: text });
      return r.ok ? `已发送给 ${agentId}` : `发送失败：${r.reason}`;
    },
    cancelAgent(agentId) {
      if (agentId === 'main') { abort?.abort(); return; }
      session.swarm.cancelSubtree(agentId, '用户取消');
    },
    togglePause(agentId) {
      if (agentId === 'main') {
        if (!session.loop.busy) return '主会话当前空闲';
        session.loop.setPaused(!session.loop.paused);
        store.setMeta({ swarm: session.swarm.tree() });
        return session.loop.paused ? '主会话将在当前步骤结束后暂停' : '主会话已恢复';
      }
      const paused = session.swarm.info(agentId)?.state !== 'paused';
      return session.swarm.setPaused(agentId, paused) ? `${agentId} ${paused ? '将在当前步骤结束后暂停' : '已恢复'}` : '该 agent 已结束';
    },
    setScreen(screen) {
      store.setMeta({ screen });
    },
    isRunning: () => running,
    whenIdle: () => pending,
    resumeSession,
    dispose() {
      abort?.abort();
      if (swarmTimer) clearTimeout(swarmTimer);
      clearTimeout(toastTimer);
      for (const off of offs) off();
    },
  };
}
