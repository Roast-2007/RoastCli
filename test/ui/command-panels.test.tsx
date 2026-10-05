import { render, cleanup } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigSchema, loadConfig } from '../../src/core/config.js';
import { createSession, type Session } from '../../src/agent/session.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import { ScriptedProvider } from '../fixtures/scripted-provider.js';
import { tempWorkspace } from '../fixtures/workspace.js';
import { createUiStore } from '../../src/ui/store/store.js';
import { createUiController } from '../../src/ui/controller.js';
import { CommandPanel } from '../../src/ui/components/CommandPanel.js';
import { SelectPanel } from '../../src/ui/components/SelectPanel.js';

vi.mock('ink', async (original) => ({ ...await original<typeof import('ink')>(), useWindowSize: () => ({ columns: 40, rows: 10 }) }));
const saved = process.env['ROAST_HOME'];
let session: Session, home: ReturnType<typeof tempWorkspace>, ws: ReturnType<typeof tempWorkspace>;
const tick = () => new Promise((resolve) => setTimeout(resolve, 40));
async function press(stdin: { write(text: string): void }, ...keys: string[]) { for (const key of keys) { stdin.write(key); await tick(); } }
async function waitForFrame(view: { lastFrame(): string | undefined }, text: string) {
  await vi.waitFor(() => expect(view.lastFrame()).toContain(text), { timeout: 3000 });
}
beforeEach(async () => {
  home = tempWorkspace(); ws = tempWorkspace(); process.env['ROAST_HOME'] = home.dir;
  const config = ConfigSchema.parse({ providers: { p: { driver: 'openai-compat', auth: 'none', baseURL: 'https://example.test/v1', models: { m: {}, small: { reasoningEfforts: ['low', 'high'] } } } }, default: 'p:m', swarm: { worktrees: false } });
  home.file('config.json', JSON.stringify(config));
  const providers = new ProviderRegistry(); providers.register('p', new ScriptedProvider([]));
  session = await createSession({ cwd: ws.dir, config, providers });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'remote', context_window: 8000 }] }))));
});
afterEach(async () => { cleanup(); await session.shutdown(); vi.unstubAllGlobals(); if (saved === undefined) delete process.env['ROAST_HOME']; else process.env['ROAST_HOME'] = saved; });
function screen(kind: 'theme' | 'model' | 'hive-models' | 'mode' | 'init' | 'board') {
  const store = createUiStore(); const controller = createUiController(session, store, { exit() {} });
  store.setMeta({ overlay: kind });
  return { ...render(<CommandPanel kind={kind} session={session} store={store} controller={controller} height={8} />), store, controller };
}
describe('interactive command panels', () => {
  it('keeps multiline labels and messages on one row so the footer remains reachable', async () => {
    const view = render(<SelectPanel title="Title\nextra" height={8} message="message\nmore" entries={[{ id: 'a', label: 'first\nsecond\nthird' }, { id: 'b', label: 'last' }]} onSelect={() => {}} onClose={() => {}} />);
    await tick(); expect(view.lastFrame()).toContain('first second third'); expect(view.lastFrame()).toContain('Esc 返回');
    expect(view.lastFrame()!.split('\n').length).toBeLessThanOrEqual(8);
  });
  it('preserves rapid search and arrow input before React renders the next frame', async () => {
    const onSelect = vi.fn();
    const view = render(<SelectPanel title="Fast input" height={8} searchable entries={['auto', 'none', 'minimal', 'low'].map((id) => ({ id, label: id }))} onSelect={onSelect} onClose={() => {}} />);
    await waitForFrame(view, 'Fast input');
    for (const key of ['\x1b[B', '\x1b[B', '\x1b[B', '\r']) view.stdin.write(key);
    expect(onSelect).toHaveBeenCalledWith({ id: 'low', label: 'low' });
    await tick();
    for (const key of ['m', 'i', 'n', '\r']) view.stdin.write(key);
    await vi.waitFor(() => expect(onSelect).toHaveBeenLastCalledWith({ id: 'minimal', label: 'minimal' }));
  });
  it('selects a theme and persists it with arrows and Enter; cancels mode without changing it', async () => {
    const view = screen('theme');
    try {
      await tick(); await press(view.stdin, '\x1b[B', '\r');
      expect(view.store.getState().meta.theme).toBe('aurora'); expect(loadConfig(ws.dir)!.ui!.theme).toBe('aurora');
      expect(view.store.getState().meta.overlay).toBeNull();
      expect(view.frames.every((frame) => frame.split('\n').length <= 8)).toBe(true);
      view.unmount();
      const mode = screen('mode'); await tick(); await press(mode.stdin, '\x1b[B', '\x1b');
      expect(session.permissions.mode).toBe('default'); mode.controller.dispose();
    } finally { view.controller.dispose(); }
  });
  it('searches fetched models and switches model plus effort, applying discovered context metadata', async () => {
    const view = screen('model');
    try {
      await waitForFrame(view, '已获取'); await press(view.stdin, 'remote');
      await waitForFrame(view, 'p:remote'); await press(view.stdin, '\r');
      await waitForFrame(view, '推理强度');
      await press(view.stdin, '\x1b[B', '\x1b[B', '\x1b[B', '\r'); // auto, none, minimal, low
      await vi.waitFor(() => expect(view.store.getState().meta.overlay).toBeNull());
      expect(session.model).toBe('remote'); expect(session.reasoningEffort).toBe('low'); expect(session.contextStats().window).toBe(8000);
      expect(view.store.getState().meta.overlay).toBeNull();
      expect(session.loop.committer.messages()).toEqual([]);
      expect(view.frames.every((frame) => frame.split('\n').length <= 8)).toBe(true);
    } finally { view.controller.dispose(); }
  });
  it('edits one Hive role without changing the main model, and init requires a menu action', async () => {
    const view = screen('hive-models');
    try {
      await tick(); await press(view.stdin, '\x1b[B', '\x1b[B', '\r'); // scout
      await waitForFrame(view, 'Hive · scout 模型');
      await press(view.stdin, 'small', '\r'); await waitForFrame(view, '推理强度 · p:small');
      await press(view.stdin, '\x1b[B', '\r'); await waitForFrame(view, 'Hive · 各角色模型');
      expect(loadConfig(ws.dir)!.swarm.models!.scout).toBe('p:small'); expect(loadConfig(ws.dir)!.swarm.efforts!.scout).toBe('low'); expect(session.model).toBe('m');
      view.unmount();
      const init = screen('init'); await tick(); expect(existsSync(join(ws.dir, 'ROAST.md'))).toBe(false);
      await press(init.stdin, '\r'); expect(existsSync(join(ws.dir, 'ROAST.md'))).toBe(true); init.controller.dispose();
    } finally { view.controller.dispose(); }
  });
  it('keeps failed operations in the panel and lets users read full blackboard values', async () => {
    const switchModel = vi.spyOn(session, 'switchModel').mockImplementation(() => { throw new Error('主会话忙'); });
    const view = screen('model');
    try {
      await tick(); await press(view.stdin, '\r'); await waitForFrame(view, '推理强度');
      await press(view.stdin, '\r'); await waitForFrame(view, '主会话忙'); expect(view.store.getState().meta.overlay).toBe('model');
      await press(view.stdin, '\x1b', '\x1b'); expect(view.store.getState().meta.overlay).toBeNull();
      view.unmount(); switchModel.mockRestore();
      session.swarm.board.write('/data', 'head\n' + 'long\n'.repeat(30) + 'last-secret-free-line', { author: 'main' });
      const board = screen('board'); await tick(); await press(board.stdin, '\r'); await waitForFrame(board, 'head');
      await press(board.stdin, '\x1b[F'); await waitForFrame(board, 'last-secret-free-line');
      expect(board.lastFrame()).toContain('last-secret-free-line'); expect(board.frames.every((frame) => frame.split('\n').length <= 8)).toBe(true); board.controller.dispose();
    } finally { view.controller.dispose(); }
  });
});
