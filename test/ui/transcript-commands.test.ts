import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createSession } from '../../src/agent/session.js';
import { ConfigSchema } from '../../src/core/config.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import { writeClipboardText } from '../../src/core/clipboard.js';
import { createUiController } from '../../src/ui/controller.js';
import { createUiStore } from '../../src/ui/store/store.js';
import { ScriptedProvider } from '../fixtures/scripted-provider.js';
import { reasoningTextScript, toolCallScript, textScript } from '../fixtures/chunks.js';
import { tempWorkspace } from '../fixtures/workspace.js';

vi.mock('../../src/core/clipboard.js', () => ({ writeClipboardText: vi.fn(async () => ({ ok: true, method: '系统剪贴板' })) }));

describe('transcript commands', () => {
  it('copies the requested text answer and exports without overwriting an existing file', async () => {
    const ws = tempWorkspace(),
      providers = new ProviderRegistry();
    ws.file('a.txt', 'tool output');
    providers.register(
      'p',
      new ScriptedProvider([
        reasoningTextScript('private reasoning', '第一条'),
        toolCallScript('read', 'read', { path: 'a.txt' }),
        textScript('第二条😀'),
      ]),
    );
    const config = ConfigSchema.parse({ providers: { p: { driver: 'openai-compat', auth: 'none', models: { m: {} } } }, default: 'p:m' });
    const session = await createSession({ cwd: ws.dir, config, providers });
    const store = createUiStore({ frameMs: 1 }),
      controller = createUiController(session, store, { exit() {} });
    try {
      controller.submit('first', 'first');
      await controller.whenIdle();
      controller.submit('second', 'second');
      await controller.whenIdle();
      controller.runCommand('/copy 2');
      await vi.waitFor(() => expect(writeClipboardText).toHaveBeenLastCalledWith('第一条'));
      controller.runCommand('/copy');
      await vi.waitFor(() => expect(writeClipboardText).toHaveBeenLastCalledWith('第二条😀'));
      expect(store.getState().meta.signals?.some((signal) => signal.text === '已复制 4 个字符（系统剪贴板）')).toBe(true);
      controller.runCommand('/export saved.md');
      await vi.waitFor(() => expect(store.getState().meta.signals?.some((signal) => signal.text.includes('已导出'))).toBe(true));
      const saved = path.join(ws.dir, 'saved.md'),
        original = readFileSync(saved, 'utf8');
      expect(original).toContain('第二条😀');
      expect(original).not.toContain('private reasoning');
      controller.runCommand('/export saved.md');
      await Promise.resolve();
      expect(readFileSync(saved, 'utf8')).toBe(original);
      controller.runCommand('/copy 0');
      controller.runCommand('/copy 99');
      await Promise.resolve();
      expect(writeClipboardText).toHaveBeenCalledTimes(2);
    } finally {
      controller.dispose();
      await session.shutdown();
    }
  });
});
