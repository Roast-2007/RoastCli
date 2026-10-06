import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import { render } from 'ink';
import { viewport } from '../../src/ui/viewport.js';
import { bindResizeRepaint } from '../../src/ui/resize.js';
import { ConfigSchema } from '../../src/core/config.js';
import { Deck } from '../../src/ui/hive/Deck.js';
import { createSession } from '../../src/agent/session.js';
import { createUiStore } from '../../src/ui/store/store.js';
import { createUiController } from '../../src/ui/controller.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import { ScriptedProvider } from '../fixtures/scripted-provider.js';
import { tempWorkspace } from '../fixtures/workspace.js';
import type { EditorState } from '../../src/ui/input/editor.js';
import { displayWidth } from '../../src/core/text-width.js';

class Terminal extends EventEmitter {
  isTTY = true; writable = true; columns = 120; rows = 40; chunks: string[] = [];
  write(chunk: string) { this.chunks.push(chunk); return true; }
}
class Input extends PassThrough { isTTY = true; setRawMode() {} ref() {} unref() {} }
const tick = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms));
describe('usable viewport and full resize repaint', () => {
  it('resolves gutter bounds, environment precedence and narrow terminals', () => {
    for (const gutter of [0, 1, 2, 3, 4]) expect(viewport(100, 40, gutter, {})).toMatchObject({ columns: 100 - gutter, rows: 39, gutter });
    expect(viewport(29, 10, 4, { ROAST_GUTTER: '3' })).toMatchObject({ columns: 29, gutter: 0 });
    expect(viewport(30, 10, 4, { ROAST_GUTTER: '1' }).columns).toBe(29);
    for (const value of ['-1', '5', '1.5', 'bad', '']) expect(viewport(40, 10, 2, { ROAST_GUTTER: value }).gutter).toBe(2);
    expect(viewport(0, 0, 2, {})).toMatchObject({ columns: 1, rows: 1 });
    const base = { providers: { p: { driver: 'openai-compat' } }, default: 'p:m' };
    expect(ConfigSchema.parse({ ...base, ui: {} }).ui?.gutter).toBe(2);
    for (const gutter of [-1, 5, 1.5]) expect(ConfigSchema.safeParse({ ...base, ui: { gutter } }).success).toBe(false);
  });
  it('repaints both dimensions without remounting the Deck or losing the draft and member', async () => {
    const providers = new ProviderRegistry(); providers.register('p', new ScriptedProvider([]));
    const session = await createSession({ cwd: tempWorkspace().dir, providers, config: ConfigSchema.parse({ providers: { p: { driver: 'openai-compat', auth: 'none' } }, default: 'p:m', ui: { motion: 'reduced' }, swarm: { worktrees: false } }) });
    const store = createUiStore(), controller = createUiController(session, store, { exit() {} });
    const tty = new Terminal(), stdin = new Input(), draft: { seed?: number; state?: EditorState } = {};
    const tree = <Deck session={session} store={store} controller={controller} inputDraft={draft} onExit={() => {}} />;
    const instance = render(tree, { stdout: tty as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, interactive: true, alternateScreen: true, incrementalRendering: true, patchConsole: false, exitOnCtrlC: false });
    const stop = bindResizeRepaint(tty as unknown as NodeJS.WriteStream, instance, () => tree);
    try {
      await tick(); stdin.write('中文 hive draft'); await tick();
      stdin.write('\t'); await tick(); stdin.write('\r'); await tick();
      const selected = store.getState().focus;
      for (const [columns, rows] of [[120, 40], [60, 20], [200, 60], [30, 10], [100, 30], [100, 20]]) {
        tty.chunks = []; tty.columns = columns!; tty.rows = rows!; tty.emit('resize'); await tick(150); await instance.waitUntilRenderFlush();
        const clearAt = tty.chunks.findIndex(chunk => chunk.includes('\x1b[2J\x1b[H'));
        expect(clearAt).toBeGreaterThanOrEqual(0);
        const frame = tty.chunks.slice(clearAt + 1).map(stripVTControlCharacters).find(text => text.includes('\n') && text.trim().length > 0)!;
        expect(frame).toBeDefined();
        const lines = frame.trimEnd().split('\n');
        expect(lines.length).toBeLessThanOrEqual(rows! - 1);
        expect(lines.every(line => displayWidth(line) <= columns! - 2), frame).toBe(true);
        expect(draft.state?.lines.join('')).toBe('中文 hive draft');
        expect(store.getState().focus).toBe(selected);
      }
    } finally { stop(); instance.unmount(); await instance.waitUntilExit(); instance.cleanup(); controller.dispose(); await session.shutdown(); }
    expect(tty.listenerCount('resize')).toBe(0);
  });
});
