import { describe, expect, it } from 'vitest';
import { createSession } from '../../src/agent/session.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import { ScriptedProvider } from '../fixtures/scripted-provider.js';
import { textScript } from '../fixtures/chunks.js';
import { tempWorkspace } from '../fixtures/workspace.js';
import { replayMismatches } from '../fixtures/replay.js';
import type { RoastConfig } from '../../src/core/config.js';

describe('live model switch', () => {
  it('preserves history and fixed tools, updates the context window, and resumes the latest model', async () => {
    const ws = tempWorkspace();
    const config: RoastConfig = { providers: { p: { driver: 'openai-compat', apiKeyEnv: 'UNUSED', models: { m: { pricing: { input: 1, output: 2 } }, small: { contextWindow: 8000, pricing: { input: 10, output: 20 } } } } }, default: 'p:m', maxSteps: 10, logsDir: 'logs', debugLog: false, context: {}, swarm: { maxAgents: 12, maxDepth: 3, maxMinutes: 60 } };
    const provider = new ScriptedProvider([textScript('first'), textScript('second')], { models: { small: { id: 'small', contextWindow: 8000 } } });
    const providers = new ProviderRegistry(); providers.register('p', provider);
    let session = await createSession({ cwd: ws.dir, config, providers });
    const logPath = session.log.path;
    try {
      for await (const _ of session.loop.run('hello')) {}
      session.switchModel('p:small');
      expect(session.model).toBe('small');
      expect(session.swarm.info('main')?.model).toBe('p:small');
      expect(session.cost()).toBeCloseTo(0.00002);
      expect(session.contextStats().window).toBe(8000);
      for await (const _ of session.loop.run('follow-up')) {}
      expect(provider.requests[1]?.model).toBe('small');
      expect(provider.requests[1]?.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'assistant' })]));
      expect(provider.requests[1]?.tools).toEqual(provider.requests[0]?.tools);
      expect(replayMismatches(logPath)).toEqual([]);
      expect(session.cost()).toBeCloseTo(0.00022);
      await session.shutdown();
      session = await createSession({ cwd: ws.dir, config, providers, resumeLogPath: logPath });
      expect(session.model).toBe('small');
      expect(session.loop.committer.messages()).toHaveLength(4);
      expect(session.cost()).toBeCloseTo(0.00022);
    } finally { await session.shutdown(); }
  });
});
