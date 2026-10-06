import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { render } from 'ink';
import type { RoastConfig } from '../../../src/core/config.js';
import { ConfigSchema } from '../../../src/core/config.js';
import { Deck } from '../../../src/ui/hive/Deck.js';
import { createUiStore } from '../../../src/ui/store/store.js';
import { createUiController } from '../../../src/ui/controller.js';
import { createSession } from '../../../src/agent/session.js';
import { ProviderRegistry } from '../../../src/providers/adapter.js';
import { ScriptedProvider } from '../../fixtures/scripted-provider.js';
import { tempWorkspace } from '../../fixtures/workspace.js';
import type { EditorState } from '../../../src/ui/input/editor.js';
export const tick = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));
export class Terminal extends EventEmitter {
  isTTY = true; writable = true; chunks: string[] = [];
  constructor(public columns = 120, public rows = 40) { super(); }
  write(chunk: string) { this.chunks.push(chunk); return true; }
  frame() { return this.chunks.map(stripVTControlCharacters).filter(text => text.trim().length > 0).at(-1) ?? ''; }
}
export class Input extends PassThrough { isTTY = true; setRawMode() {} ref() {} unref() {} }
export async function deckFixture(columns = 120, rows = 40, ui?: RoastConfig['ui']) {
  const providers = new ProviderRegistry(); providers.register('p', new ScriptedProvider([]));
  const session = await createSession({ cwd: tempWorkspace().dir, providers, config: ConfigSchema.parse({ providers: { p: { driver: 'openai-compat', auth: 'none' } }, default: 'p:m', ui: { motion: 'reduced', ...ui }, swarm: { worktrees: false } }) });
  const store = createUiStore(), controller = createUiController(session, store, { exit() {} });
  const tty = new Terminal(columns, rows), stdin = new Input(), draft: { seed?: number; state?: EditorState } = {};
  const element = <Deck session={session} store={store} controller={controller} inputDraft={draft} onExit={() => {}} />;
  const instance = render(element, { stdout: tty as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, interactive: true, alternateScreen: true, incrementalRendering: false, patchConsole: false, exitOnCtrlC: false });
  await tick();
  return { session, store, controller, tty, stdin, draft, instance,
    send: async (text: string) => { stdin.write(text); await tick(); },
    close: async () => { instance.unmount(); await instance.waitUntilExit(); instance.cleanup(); controller.dispose(); await session.shutdown(); },
  };
}
