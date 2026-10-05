import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createSession } from '../../src/agent/session.js';
import { ConfigSchema } from '../../src/core/config.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import { parseRoleModels } from '../../src/swarm/model-routing.js';
import { ScriptedProvider } from '../fixtures/scripted-provider.js';
import { textScript, toolCallScript, usageOf } from '../fixtures/chunks.js';
import { tempWorkspace } from '../fixtures/workspace.js';
import { loadRunLog } from '../../src/session/projection.js';

function fixture() {
  const config = ConfigSchema.parse({
    providers: {
      p: { driver: 'openai-compat', auth: 'none', models: { big: { pricing: { input: 10, output: 20 } } } },
      q: { driver: 'anthropic', auth: 'none', models: { small: { pricing: { input: 1, output: 2 } } } },
    },
    default: 'p:big',
    swarm: { worktrees: false },
  });
  const providers = new ProviderRegistry();
  return { config, providers, cwd: tempWorkspace().dir };
}

describe('session assembly regression', () => {
  it('wires cheap model summaries, child cost events and their replay without overwriting child logs', async () => {
    const f = fixture();
    const p = new ScriptedProvider([textScript('requirements remembered'), textScript('second response')]);
    const q = new ScriptedProvider([
      textScript('Concise handoff', usageOf(50, 10)),
      textScript('scout result', usageOf(100, 20)),
      textScript('another scout'),
    ]);
    f.providers.register('p', p);
    f.providers.register('q', q);
    let session = await createSession(f);
    const log = session.log.path;
    try {
      for await (const _ of session.loop.run('first requirement')) {
      }
      for await (const _ of session.loop.run('second requirement')) {
      }
      await session.compact('keep requirements');
      expect(q.requests[0]!.model).toBe('small');
      expect(session.costBreakdown!().entries.find((e) => e.kind === 'summary')).toMatchObject({
        provider: 'q',
        model: 'small',
        usage: usageOf(50, 10),
      });
      expect(session.swarm.configureModels('main', { scout: 'q:small' })).toContain('scout=q:small');
      const scout = session.swarm.spawn('main', { role: 'scout', task: 'inspect' });
      expect(scout.ok).toBe(true);
      await session.swarm.whenIdle();
      expect(session.costBreakdown!().agents.some((g) => g.id === 's1' && g.cost !== null && g.cost > 0)).toBe(true);
      const total = session.cost();
      await session.shutdown();
      session = await createSession({ ...f, resumeLogPath: log });
      expect(session.cost()).toBeCloseTo(total!);
      const next = session.swarm.spawn('main', { role: 'scout', task: 'next', model: 'q:small' });
      expect(next).toMatchObject({ ok: true, id: 's2' });
      await session.swarm.whenIdle();
      expect(loadRunLog(join(log, '..', 'agents', 's1.jsonl')).header.model).toBe('small');
    } finally {
      await session.shutdown();
    }
  });
  it('lets Queen configure unspecified roles through tools and protects user models including inherit', async () => {
    const f = fixture();
    const p = new ScriptedProvider([
      toolCallScript('routing', 'configure_swarm', { models: { scout: 'q:small' } }),
      textScript('configured'),
      textScript('inherited'),
    ]);
    const q = new ScriptedProvider([textScript('queen answer'), textScript('scout answer')]);
    f.providers.register('p', p);
    f.providers.register('q', q);
    const session = await createSession({ ...f, roleModels: parseRoleModels(['worker=inherit', 'critic=p:big']) });
    try {
      for await (const _ of session.loop.run('choose suitable roles')) {
      }
      expect(p.requests[0]!.system).toContain('q:small');
      expect(session.swarm.spawn('main', { role: 'scout', task: 'search' }).ok).toBe(true);
      await session.swarm.whenIdle();
      expect(q.requests[0]!.model).toBe('small');
      expect(() => session.swarm.configureModels('main', { worker: 'q:small' })).toThrow('用户指定');
      expect(() => session.swarm.configureModels('main', { critic: 'q:small' })).toThrow('用户指定');
      expect(session.swarm.spawn('main', { role: 'worker', task: 'override', model: 'q:small' })).toMatchObject({ ok: false });
      expect(() => session.swarm.configureModels('s1', { lead: 'q:small' })).toThrow('只有 Queen');
      session.configureSwarmModels!({ queen: 'q:small', lead: 'p:big' });
      expect(session.model).toBe('small');
      expect(() => session.swarm.configureModels('main', { lead: 'q:small' })).toThrow('用户指定');
      for await (const _ of session.loop.run('queen')) {
      }
      expect(q.requests[1]!.model).toBe('small');
    } finally {
      await session.shutdown();
    }
    expect(() => parseRoleModels(['unknown=p:m'])).toThrow();
    expect(() => parseRoleModels(['worker=missing-provider'])).toThrow();
  });
  it('validates cache prefixes after compaction, rewind and a model change', async () => {
    const f = fixture();
    f.config.context.summaryModel = 'extractive';
    const p = new ScriptedProvider(Array.from({ length: 6 }, () => textScript('response')));
    const q = new ScriptedProvider([textScript('switched')]);
    f.providers.register('p', p);
    f.providers.register('q', q);
    const session = await createSession(f);
    try {
      for await (const _ of session.loop.run('one')) {
      }
      for await (const _ of session.loop.run('two')) {
      }
      expect(p.requests[1]!.cacheBoundary).toBe(1);
      expect(p.requests[1]!.cacheKey).toBe(p.requests[0]!.cacheKey);
      await session.compact();
      for await (const _ of session.loop.run('three')) {
      }
      expect(p.requests[2]!.cacheBoundary).toBeUndefined();
      await session.rewind(2);
      for await (const _ of session.loop.run('replacement')) {
      }
      expect(p.requests[3]!.cacheBoundary).toBeUndefined();
      session.switchModel('q:small');
      for await (const _ of session.loop.run('continue')) {
      }
      expect(q.requests[0]!.cacheBoundary).toBeUndefined();
      expect(q.requests[0]!.cacheKey).not.toBe(p.requests[0]!.cacheKey);
    } finally {
      await session.shutdown();
    }
  });
});
