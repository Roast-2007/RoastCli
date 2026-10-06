import { describe, expect, it } from 'vitest';
import { createSession } from '../../../src/agent/session.js';
import { ConfigSchema } from '../../../src/core/config.js';
import { ProviderRegistry } from '../../../src/providers/adapter.js';
import { createUiController } from '../../../src/ui/controller.js';
import { createUiStore } from '../../../src/ui/store/store.js';
import { ScriptedProvider } from '../../fixtures/scripted-provider.js';
import { textScript } from '../../fixtures/chunks.js';
import { tempWorkspace } from '../../fixtures/workspace.js';
describe('Deck input routing', () => {
  it('delivers member instructions to the mailbox and Queen text to the runtime', async () => {
    const providers = new ProviderRegistry(); const provider = new ScriptedProvider([textScript('scout'), textScript('queen')], { chunkDelayMs: 20 }); providers.register('p', provider);
    const session = await createSession({ cwd: tempWorkspace().dir, providers, config: ConfigSchema.parse({ providers: { p: { driver: 'openai-compat', auth: 'none' } }, default: 'p:m', swarm: { worktrees: false } }) });
    const store = createUiStore(); const controller = createUiController(session, store, { exit() {} });
    try {
      controller.setScreen('hive');
      const child = session.swarm.spawn('main', { role: 'scout', task: 'read' });
      expect(child.ok).toBe(true); if (!child.ok) return;
      controller.submit(`@${child.id} change scope`, 'instruction');
      expect(session.swarm.mailbox(child.id)!.drainPeek()).toMatchObject([{ kind: 'steer', body: 'change scope' }]);
      await session.swarm.whenIdle();
      controller.submit('@queen follow up', 'follow up'); await controller.whenIdle();
      expect(store.getState().agents.main!.items.some((item) => item.kind === 'mission')).toBe(false);
      expect(JSON.stringify(provider.requests.at(-1)!.messages)).toContain('follow up');
      controller.runCommand('/strategy critique 4'); await new Promise((resolve) => setTimeout(resolve, 10));
      expect(store.getState().meta).toMatchObject({ strategy: 'critique', n: 4 });
      controller.runCommand('/strategy invalid'); await new Promise((resolve) => setTimeout(resolve, 10));
      expect(store.getState().meta.strategy).toBe('critique');
    } finally { controller.dispose(); await session.shutdown(); }
  });
});
