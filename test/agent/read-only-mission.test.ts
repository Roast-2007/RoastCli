import { describe, expect, it } from 'vitest';
import { createSession } from '../../src/agent/session.js';
import { ConfigSchema } from '../../src/core/config.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import { RoutedProvider } from '../fixtures/routed-provider.js';
import { textScript, toolCallScript } from '../fixtures/chunks.js';
import { tempWorkspace } from '../fixtures/workspace.js';
import { loadStrategies, missionInput } from '../../src/swarm/strategies.js';
const drain = async (stream: AsyncGenerator<unknown>) => { for await (const _ of stream) {} };
describe('read-only Hive missions', () => {
  it('refuses worker and lead, permits scouts, and removes the constraint when the mission ends', async () => {
    const providers = new ProviderRegistry(), ws = tempWorkspace();
    const provider = new RoutedProvider({ main: [toolCallScript('w', 'spawn_agent', { role: 'worker', task: 'write' }), toolCallScript('l', 'task', { role: 'lead', task: 'write' }), toolCallScript('s', 'spawn_agent', { role: 'scout', task: 'read' }), toolCallScript('a', 'await_agents', {}), textScript('research done'), toolCallScript('next', 'spawn_agent', { role: 'worker', task: 'write' }), toolCallScript('wait', 'await_agents', {}), textScript('done')], s1: [textScript('scout facts')], w2: [textScript('worker done')] }); providers.register('p', provider);
    const session = await createSession({ cwd: ws.dir, providers, config: ConfigSchema.parse({ providers: { p: { driver: 'openai-compat', auth: 'none' } }, default: 'p:m', swarm: { worktrees: false } }) });
    try {
      await drain(session.loop.run(missionInput(loadStrategies(ws.dir, ws.dir), 'research', 'research')));
      expect(JSON.stringify(provider.requests)).toContain('本任务为只读调研');
      expect(session.swarm.tree().filter((agent) => agent.parentId).map((agent) => agent.role)).toEqual(['scout']);
      await drain(session.loop.run('normal conversation')); await session.swarm.whenIdle();
      expect(session.swarm.tree().some((agent) => agent.role === 'worker')).toBe(true);
      const abort = new AbortController();
      for await (const event of session.loop.run(missionInput(loadStrategies(ws.dir, ws.dir), 'interrupted', 'research'), abort.signal)) if (event.type === 'hive/mission') abort.abort();
      expect(session.swarm.spawn('main', { role: 'lead', task: 'after interruption' }).ok).toBe(true);
    } finally { await session.shutdown(); }
  });
});
