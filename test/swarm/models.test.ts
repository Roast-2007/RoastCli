import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createSession } from '../../src/agent/session.js';
import { ConfigSchema, loadConfig, type RoastConfig } from '../../src/core/config.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import { ScriptedProvider } from '../fixtures/scripted-provider.js';
import { textScript } from '../fixtures/chunks.js';
import { tempWorkspace } from '../fixtures/workspace.js';
import { loadRunLog } from '../../src/session/projection.js';

const saved = process.env['ROAST_HOME'];
let home: ReturnType<typeof tempWorkspace>;
beforeEach(() => { home = tempWorkspace(); process.env['ROAST_HOME'] = home.dir; });
afterEach(() => { if (saved === undefined) delete process.env['ROAST_HOME']; else process.env['ROAST_HOME'] = saved; });

describe('Hive independent models and effort', () => {
  it('routes by role and by spawn, isolates effort, persists role settings and rejects unknown providers before allocating an agent', async () => {
    const ws = tempWorkspace();
    const config: RoastConfig = ConfigSchema.parse({ providers: { p: { driver: 'openai-compat', auth: 'none' }, q: { driver: 'anthropic', auth: 'none' } }, default: 'p:main', swarm: { worktrees: false, models: { scout: 'q:small' }, efforts: { scout: 'low' } } });
    home.file('config.json', JSON.stringify(config));
    const p = new ScriptedProvider([textScript('main child'), textScript('inherited child')]);
    const q = new ScriptedProvider([textScript('scout'), textScript('override')]);
    const providers = new ProviderRegistry(); providers.register('p', p); providers.register('q', q);
    const session = await createSession({ cwd: ws.dir, config, providers });
    try {
      session.switchModel('p:main', 'medium');
      expect(session.swarm.spawn('main', { role: 'scout', task: 'bad', model: 'unknown:m' })).toMatchObject({ ok: false });
      expect(session.swarm.tree()).toHaveLength(1);
      const scout = session.swarm.spawn('main', { role: 'scout', task: 'role default' });
      const override = session.swarm.spawn('main', { role: 'critic', task: 'specific model', model: 'q:other', reasoningEffort: 'high' });
      const worker = session.swarm.spawn('main', { role: 'worker', task: 'main default' });
      expect([scout, override, worker].every((result) => result.ok)).toBe(true);
      await session.swarm.whenIdle();
      expect(q.requests.map((request) => [request.model, request.reasoningEffort])).toEqual([['small', 'low'], ['other', 'high']]);
      expect(p.requests[0]).toMatchObject({ model: 'main', reasoningEffort: 'medium' });
      expect(session.reasoningEffort).toBe('medium');
      expect(session.swarm.info('s1')).toMatchObject({ model: 'q:small', reasoningEffort: 'low' });
      expect(loadRunLog(join(session.log.path, '..', 'agents', 's1.jsonl')).header.model).toBe('small');
      session.setSwarmModel('scout', 'inherit');
      expect(loadConfig(ws.dir)!.swarm.models!.scout).toBe('inherit');
      session.swarm.spawn('main', { role: 'scout', task: 'inherit main effort' });
      await session.swarm.whenIdle();
      expect(p.requests[1]).toMatchObject({ model: 'main', reasoningEffort: 'medium' });
      expect(() => session.setSwarmModel('worker', 'q:m', 'none')).toThrow('不支持');
      expect(loadConfig(ws.dir)!.swarm.models!.worker).toBeUndefined();
    } finally { await session.shutdown(); }
  });
  it('restores the latest session effort, including an explicit auto override', async () => {
    const ws = tempWorkspace();
    const config = ConfigSchema.parse({ providers: { p: { driver: 'openai-compat', auth: 'none', models: { m: { reasoningEffort: 'high' } } } }, default: 'p:m' });
    const provider = new ScriptedProvider([textScript('one'), textScript('two')]);
    const providers = new ProviderRegistry(); providers.register('p', provider);
    let session = await createSession({ cwd: ws.dir, config, providers }); const log = session.log.path;
    try {
      session.switchModel('p:m', 'low');
      await session.shutdown(); session = await createSession({ cwd: ws.dir, config, providers, resumeLogPath: log });
      expect(session.reasoningEffort).toBe('low');
      for await (const _ of session.loop.run('continue')) {}
      expect(provider.requests[0]!.reasoningEffort).toBe('low');
      session.switchModel('p:m', null);
      await session.shutdown(); session = await createSession({ cwd: ws.dir, config, providers, resumeLogPath: log });
      expect(session.reasoningEffort).toBeNull();
      for await (const _ of session.loop.run('auto')) {}
      expect(provider.requests[1]!.reasoningEffort).toBeNull();
    } finally { await session.shutdown(); }
  });
});
