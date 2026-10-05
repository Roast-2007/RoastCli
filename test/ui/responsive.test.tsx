import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink';
import { App } from '../../src/ui/App.js';
import { MissionControl } from '../../src/ui/mission/MissionControl.js';
import { createSession } from '../../src/agent/session.js';
import { createUiStore } from '../../src/ui/store/store.js';
import { createUiController } from '../../src/ui/controller.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import { ScriptedProvider } from '../fixtures/scripted-provider.js';
import { tempWorkspace } from '../fixtures/workspace.js';
import { displayWidth } from '../../src/core/text-width.js';
import { stripVTControlCharacters } from 'node:util';

class Tty extends EventEmitter {
  isTTY = true; writable = true; chunks: string[] = [];
  constructor(public columns: number, public rows: number) { super(); }
  write(text: string) { this.chunks.push(text); return true; }
  // Standard Ink rendering writes a whole frame per chunk; cursor-only writes are empty.
  frames() { return this.chunks.map((chunk) => stripVTControlCharacters(chunk).trimEnd()).filter(Boolean).map((frame) => frame.split('\n')); }
}
class Input extends PassThrough { isTTY = true; setRawMode() {} ref() {} unref() {} }
afterEach(() => vi.useRealTimers());
describe('real Ink terminal constraints', () => {
  it('streams 2000 lines into scrollback without clearing the screen or losing the last block', { timeout: 15_000 }, async () => {
    const providers = new ProviderRegistry(); providers.register('p', new ScriptedProvider([]));
    const session = await createSession({ cwd: tempWorkspace().dir, providers, config: { providers: { p: { driver: 'openai-compat', apiKeyEnv: 'UNUSED' } }, default: 'p:m', maxSteps: 10, logsDir: 'logs', debugLog: false, context: {}, swarm: { maxAgents: 12, maxDepth: 3, maxMinutes: 60 }, ui: { motion: 'reduced' } } });
    const store = createUiStore(); const controller = createUiController(session, store, { exit() {} });
    const tty = new Tty(80, 24); const stdin = new Input();
    const instance = render(<App session={session} store={store} controller={controller} printedUpTo={0} />, { stdout: tty as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, interactive: true, patchConsole: false, exitOnCtrlC: false, maxFps: 30, incrementalRendering: true });
    try {
      store.pushEvent('main', { type: 'turn-start', turn: 1 });
      for (let batch = 0; batch < 20; batch++) {
        store.pushEvent('main', { type: 'text-delta', text: Array.from({ length: 100 }, (_, i) => `line-${batch * 100 + i} 中文 output\n\n`).join('') });
        store.flush(); await instance.waitUntilRenderFlush();
      }
      store.pushEvent('main', { type: 'turn-end', reason: 'completed', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
      await instance.waitUntilRenderFlush();
      expect(tty.chunks.join('')).not.toContain('\u001b[2J');
      expect(stripVTControlCharacters(tty.chunks.join(''))).toContain('line-1999 中文 output');
      expect(store.getState().agents.main!.pending).toBe('');
      expect(tty.listenerCount('resize')).toBeLessThan(10);
    } finally { instance.unmount(); await instance.waitUntilExit(); controller.dispose(); await session.shutdown(); }
  });
  it.each([[40, 10], [60, 16], [80, 24], [120, 40]])('inline and mission fit %i×%i with huge drafts, tool output and permission queues', async (columns, rows) => {
    const ws = tempWorkspace();
    const providers = new ProviderRegistry(); providers.register('p', new ScriptedProvider([]));
    const session = await createSession({ cwd: ws.dir, providers, config: { providers: { p: { driver: 'openai-compat', apiKeyEnv: 'UNUSED' } }, default: 'p:m', maxSteps: 10, logsDir: 'logs', debugLog: false, context: {}, swarm: { maxAgents: 12, maxDepth: 3, maxMinutes: 60 }, ui: { motion: 'reduced' } } });
    const store = createUiStore();
    const controller = createUiController(session, store, { exit() {} });
    store.pushEvent('main', { type: 'turn-start', turn: 1 });
    store.pushEvent('main', { type: 'tool-call-start', name: 'bash', callId: 'x', args: { command: '中文'.repeat(200) } });
    store.pushEvent('main', { type: 'tool-progress', callId: 'x', text: ('中文'.repeat(200) + '\n').repeat(100) });
    store.pushEvent('main', { type: 'text-delta', text: '```ts\n' + 'long'.repeat(5000) });
    store.flush();
    store.setMeta({ inputSeed: { key: 1, text: Array.from({ length: 100 }, () => '中文👩‍💻'.repeat(40)).join('\n') } });
    const tty = new Tty(columns, rows);
    const stdin = new Input();
    const options = { stdout: tty as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, interactive: true, patchConsole: false, exitOnCtrlC: false, incrementalRendering: false };
    let instance = render(<App session={session} store={store} controller={controller} printedUpTo={0} />, options);
    try {
      await instance.waitUntilRenderFlush();
      const frames = tty.frames();
      expect(frames.length).toBeGreaterThan(0);
      for (const frame of frames) {
        expect(frame.length).toBeLessThan(rows);
        expect(frame.every((line) => displayWidth(line) <= columns)).toBe(true);
      }
      expect(tty.chunks.join('')).not.toContain('\u001b[2J');
      store.setMeta({ interactions: [{ id: 'p', agentId: 'main', kind: 'permission', tool: 'bash', title: 'bash huge', detail: 'content '.repeat(500), reason: 'reason', forced: true }] });
      await instance.waitUntilRenderFlush();
      expect(tty.chunks.join('')).not.toContain('\u001b[2J');
      instance.unmount(); await instance.waitUntilExit();
      tty.chunks = [];
      instance = render(<MissionControl session={session} store={store} controller={controller} onExit={() => {}} />, { ...options, alternateScreen: true });
      await instance.waitUntilRenderFlush();
      expect(tty.chunks.join('')).not.toContain('\u001b[2J');
      tty.columns = 25; tty.rows = 8; tty.emit('resize');
      await new Promise((resolve) => setTimeout(resolve, 50));
      await instance.waitUntilRenderFlush();
      // Ink clears once while its previous frame is taller than a newly resized screen.
      // Subsequent paints must stay bounded and use incremental writes.
      tty.chunks = [];
      store.setMeta({ mode: 'plan' });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await instance.waitUntilRenderFlush();
      expect(tty.chunks.join('')).not.toContain('\u001b[2J');
    } finally { instance.unmount(); await instance.waitUntilExit(); controller.dispose(); await session.shutdown(); }
  });
});
