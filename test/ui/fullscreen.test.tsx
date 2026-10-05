import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, type Instance } from 'ink';
import { App } from '../../src/ui/App.js';
import { MissionControl } from '../../src/ui/mission/MissionControl.js';
import { createSession, type Session } from '../../src/agent/session.js';
import { ConfigSchema } from '../../src/core/config.js';
import { createUiStore, type OverlayKind } from '../../src/ui/store/store.js';
import { createUiController, type UiController } from '../../src/ui/controller.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import { ScriptedProvider } from '../fixtures/scripted-provider.js';
import { textScript, toolCallScript } from '../fixtures/chunks.js';
import { tempWorkspace } from '../fixtures/workspace.js';
import { displayWidth } from '../../src/core/text-width.js';
import type { EditorState } from '../../src/ui/input/editor.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

class Terminal extends EventEmitter {
  isTTY = true; writable = true; chunks: string[] = [];
  constructor(public columns: number, public rows: number) { super(); }
  write(chunk: string) { this.chunks.push(chunk); return true; }
  frames() { return this.chunks.map((chunk) => stripVTControlCharacters(chunk).trimEnd()).filter(Boolean); }
}
class Input extends PassThrough { isTTY = true; setRawMode() {} ref() {} unref() {} }
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
let session: Session, controller: UiController, instance: Instance | undefined;
beforeEach(async () => {
  vi.stubEnv('TERM', 'xterm-256color'); vi.stubEnv('ROAST_REDUCED_MOTION', '0'); vi.stubEnv('ROAST_ASCII', '0');
  const providers = new ProviderRegistry(); providers.register('p', new ScriptedProvider([]));
  session = await createSession({ cwd: tempWorkspace().dir, providers, config: ConfigSchema.parse({ providers: { p: { driver: 'openai-compat', auth: 'none', baseURL: 'https://example.test/v1', models: { m: {} } } }, default: 'p:m', logsDir: 'logs', ui: { motion: 'reduced' }, swarm: { worktrees: false } }) });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'm' }] }))));
});
afterEach(async () => { const exited = instance?.waitUntilExit(); instance?.unmount(); await exited; instance?.cleanup(); instance = undefined; controller?.dispose(); await session.shutdown(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function workspace(columns = 80, rows = 24, startup = false) {
  const store = createUiStore(); controller = createUiController(session, store, { exit() {} });
  const tty = new Terminal(columns, rows), stdin = new Input();
  const draft: { seed?: number; state?: EditorState } = {};
  const app = () => <App session={session} store={store} controller={controller} fullScreen startup={startup} inputDraft={draft} />;
  instance = render(app(), { stdout: tty as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, interactive: true, patchConsole: false, alternateScreen: true, incrementalRendering: false, exitOnCtrlC: false });
  return { store, tty, stdin, draft, app };
}
function fits(tty: Terminal) {
  const frames = tty.frames();
  expect(frames.length).toBeGreaterThan(0);
  for (const frame of frames) {
    expect(frame.split('\n').length, frame).toBeLessThan(tty.rows);
    expect(frame.split('\n').every((line) => displayWidth(line) <= tty.columns), frame).toBe(true);
  }
}

describe('fullscreen workspace in real Ink', () => {
  it('runs a complete 2000-line answer, returns to its beginning and keeps all frames bounded', async () => {
    const cwd = session.log.header.cwd, config = session.config;
    await session.shutdown();
    const providers = new ProviderRegistry();
    providers.register('p', new ScriptedProvider([textScript(Array.from({ length: 2000 }, (_, i) => `response-${i} 中文👩‍💻`).join('\n\n'))]));
    session = await createSession({ cwd, config, providers });
    const { tty, stdin, store } = workspace();
    await tick(); stdin.write('生成计划'); await tick(); stdin.write('\r'); await tick();
    await controller.whenIdle(); store.flush(); await tick();
    expect(tty.frames().at(-1)).toContain('response-1999');
    stdin.write('\x1b[5~'); await tick(); stdin.write('\x1b[H'); await tick();
    expect(tty.frames().at(-1)).toContain('生成计划'); expect(tty.frames().at(-1)).toContain('response-0');
    expect(tty.chunks.join('')).not.toContain('\x1b[2J'); fits(tty);
  });
  it('approves a real write, displays its diff statistics and completes the agent turn', { timeout: 20_000 }, async () => {
    const cwd = session.log.header.cwd, config = session.config;
    await session.shutdown();
    const providers = new ProviderRegistry(); providers.register('p', new ScriptedProvider([toolCallScript('w', 'write', { path: 'tui-result.txt', content: 'validated\n' }), textScript('写入已完成')]));
    session = await createSession({ cwd, config, providers });
    const { tty, stdin } = workspace(); await tick();
    stdin.write('write file'); await tick(); stdin.write('\r');
    await vi.waitFor(() => expect(tty.frames().at(-1)).toContain('需要你的授权'), { timeout: 3000 });
    stdin.write('1'); await tick(); await controller.whenIdle(); await tick();
    expect(existsSync(join(cwd, 'tui-result.txt'))).toBe(true);
    expect(readFileSync(join(cwd, 'tui-result.txt'), 'utf8')).toBe('validated\n');
    expect(tty.frames().join('\n')).toContain('+1 -0'); expect(tty.frames().at(-1)).toContain('写入已完成'); fits(tty);
  });
  it.each([[20, 5], [25, 8], [40, 10], [60, 16], [80, 24], [120, 40]])('fits every command panel, huge drafts and approvals at %i×%i', async (columns, rows) => {
    const { store, tty } = workspace(columns, rows);
    store.setMeta({ inputSeed: { key: 1, text: ('中文👩‍💻'.repeat(30) + '\n').repeat(30) } });
    store.addNotice('main', ('long 中文 text\n').repeat(100));
    await instance!.waitUntilRenderFlush(); fits(tty); tty.chunks = [];
    const kinds: OverlayKind[] = ['help', 'context', 'rewind', 'sessions', 'theme', 'mode', 'model', 'hive-models', 'swarm', 'skills', 'board', 'cost', 'todo', 'mcp', 'logs', 'memory', 'compact', 'init', 'agents'];
    for (const overlay of kinds) {
      store.setMeta({ overlay }); await tick(15); await instance!.waitUntilRenderFlush(); fits(tty); tty.chunks = [];
    }
    store.setMeta({ overlay: null, interactions: [{ id: 'permission', agentId: 'main', kind: 'permission', tool: 'bash', title: '中文'.repeat(100), detail: 'large detail\n'.repeat(100), reason: 'reason', forced: true }] });
    await instance!.waitUntilRenderFlush(); fits(tty);
    expect(tty.chunks.join('')).not.toContain('\x1b[2J');
  });
  it('reads a long plan continuously, preserves the draft, clamps at both ends and accumulates rapid arrows', async () => {
    const { store, stdin, tty, draft } = workspace();
    session.permissions.setMode('plan');
    store.setMeta({ inputSeed: { key: 1, text: '未发送的草稿👩‍💻' } });
    store.addNotice('main', Array.from({ length: 150 }, (_, i) => `plan-step-${i}`).join('\n'));
    await instance!.waitUntilRenderFlush();
    stdin.write('\x1b[5~'); await tick();
    expect(tty.frames().at(-1)).toContain('阅读 ·');
    stdin.write('\x1b[H'); await tick();
    expect(tty.frames().at(-1)).toContain('plan-step-0');
    for (let i = 0; i < 4; i++) stdin.write('\x1b[B');
    await tick(); expect(tty.frames().at(-1)).toContain('阅读 · 5–');
    expect(draft.state?.lines.join('\n')).toBe('未发送的草稿👩‍💻');
    for (let i = 0; i < 200; i++) stdin.write('\x1b[A');
    await tick(); stdin.write('\x1b[B'); await tick();
    expect(tty.frames().at(-1)).toContain('阅读 · 2–');
    store.addNotice('main', 'new tail while reading'); await instance!.waitUntilRenderFlush();
    expect(tty.frames().at(-1)).toContain('阅读 · 2–');
    stdin.write('\x1b[F'); await tick();
    expect(tty.frames().at(-1)).toContain('new tail while reading');
    expect(tty.frames().at(-1)).not.toMatch(/阅读 · \d/); fits(tty);
  });
  it('help scrolls text without a selected row or command execution; tool arrows move one line', async () => {
    const { store, stdin, tty } = workspace(60, 16);
    const command = vi.spyOn(controller, 'runCommand');
    store.setMeta({ overlay: 'help' }); await tick();
    expect(tty.frames().at(-1)).not.toContain('Enter 打开命令');
    expect(tty.frames().at(-1)).not.toMatch(/│ › /);
    for (let i = 0; i < 4; i++) stdin.write('\x1b[B');
    await tick(); expect(tty.frames().at(-1)).toContain('5–');
    stdin.write('\r'); await tick(); expect(command).not.toHaveBeenCalled(); expect(store.getState().meta.overlay).toBeNull();
    store.pushEvent('main', { type: 'tool-call-start', name: 'read', callId: 'read', args: { path: 'x' } });
    store.pushEvent('main', { type: 'tool-call-end', callId: 'read', name: 'read', isError: false, preview: 'tool-line-0', output: Array.from({ length: 60 }, (_, i) => `tool-line-${i}`).join('\n'), durationMs: 10 });
    store.flush(); await tick(); stdin.write('\x0f'); await tick();
    expect(tty.frames().at(-1)).toContain('tool-line-0');
    stdin.write('\x1b[B'); await tick(); expect(tty.frames().at(-1)).toContain('tool-line-1'); expect(tty.frames().at(-1)).not.toContain('tool-line-0\n');
  });
  it('keeps one alternate buffer, history and editor state across mission and provider-style handoffs', async () => {
    const { store, tty, stdin, draft, app } = workspace();
    store.addNotice('main', 'history-before-switch'); await tick();
    stdin.write('draft remains'); await tick();
    instance!.rerender(<MissionControl session={session} store={store} controller={controller} onExit={() => {}} />); await tick();
    store.addNotice('main', 'history-during-switch');
    instance!.rerender(app()); await tick();
    const frame = tty.frames().at(-1)!;
    expect(frame).toContain('history-before-switch'); expect(frame).toContain('history-during-switch'); expect(frame).toContain('draft remains');
    expect(draft.state?.lines).toEqual(['draft remains']);
    expect(tty.chunks.join('').match(/\x1b\[\?1049h/g)).toHaveLength(1);
    expect(tty.chunks.join('')).not.toContain('\x1b[?1049l');
    expect(tty.chunks.join('')).not.toContain('\x1b[2J'); fits(tty);
  });
  it('resizes while reading and shows the final line after returning to live output', async () => {
    const { store, tty, stdin } = workspace(120, 40);
    store.addNotice('main', ('中文👩‍💻'.repeat(50) + '\n').repeat(40) + '\nLAST-LINE'); await tick();
    stdin.write('\x1b[5~'); await tick();
    for (const [columns, rows] of [[25, 8], [40, 10], [80, 24], [120, 40]]) {
      tty.columns = columns!; tty.rows = rows!; tty.emit('resize'); await tick(); tty.chunks = [];
      store.setMeta({ toast: { text: `resize ${columns}×${rows}`, tone: 'info' } }); await tick(); fits(tty); expect(tty.chunks.join('')).not.toContain('\x1b[2J');
    }
    stdin.write('\x1b[F'); await tick(); expect(tty.frames().at(-1)).toContain('LAST-LINE');
  });
  it('renders the character startup, accepts a typed skip and stops animation timers', async () => {
    session.config.ui = { motion: 'full' };
    const { tty, stdin, draft } = workspace(80, 24, true);
    await vi.waitFor(() => expect(tty.frames().at(-1)).toContain('TERMINAL WORKSPACE'));
    await instance!.waitUntilRenderFlush();
    for (const character of ['a', 'b', 'c']) stdin.write(character);
    await vi.waitFor(() => expect(draft.state?.lines.join('\n')).toBe('abc'));
    await instance!.waitUntilRenderFlush(); expect(tty.frames().at(-1)).not.toContain('TERMINAL WORKSPACE');
    fits(tty); expect(tty.chunks.join('')).not.toContain('\x1b[2J');
    await tick(300); const frames = tty.frames().length; await tick(100); expect(tty.frames().length).toBe(frames);
  });
});
