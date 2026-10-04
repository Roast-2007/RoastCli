/**
 * Supervisor.wait 的边界语义：中断时不吞掉报告；done 时报告随结果返回且不重复投递。
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { Supervisor } from '../../src/swarm/supervisor.js';
import { MapToolServices } from '../../src/tools/tool.js';
import { tempWorkspace } from '../fixtures/workspace.js';

function supervisorWithInstantReporters() {
  const dir = tempWorkspace('roast-wait-').dir;
  const sup: Supervisor = new Supervisor({
    mainLogPath: path.join(dir, 'run', 'log.jsonl'),
    runId: 'r',
    cwd: dir,
    createServices: () => new MapToolServices(),
    modelFor: () => ({ provider: 'p', model: 'm' }),
    createRuntime: ({ id }) =>
      ({
        setPaused() {},
        async *run() {
          sup.report(id, { agentId: id, status: 'done', summary: `${id} 完成`, refs: [] });
        },
      }) as never,
  });
  sup.registerRoot('main', 'p:m');
  return sup;
}

describe('Supervisor.wait', () => {
  it('reports runtime setup failures and completes the wait instead of leaving a live child', async () => {
    const dir = tempWorkspace().dir;
    const sup = new Supervisor({ mainLogPath: path.join(dir, 'log.jsonl'), runId: 'r', cwd: dir, createServices: () => new MapToolServices(), modelFor: () => ({ provider: 'p', model: 'm' }), createRuntime: () => { throw new Error('provider setup failed'); } });
    sup.registerRoot('main', 'p:m'); sup.spawn('main', { role: 'scout', task: 'task' });
    await sup.whenIdle();
    expect(sup.info('s1')?.state).toBe('failed');
    const result = await sup.wait('main', [], 'all', { signal: new AbortController().signal });
    expect(result.reports[0]).toMatchObject({ status: 'failed', summary: 'provider setup failed' });
  });
  it('leaves reports in the inbox when the wait is aborted', async () => {
    const sup = supervisorWithInstantReporters();
    sup.spawn('main', { role: 'scout', task: 'a' });
    await sup.whenIdle();
    const ac = new AbortController();
    ac.abort();

    const r = await sup.wait('main', [], 'all', { signal: ac.signal });

    expect(r.reason).toBe('aborted');
    expect(sup.mailbox('main')!.drainPeek().filter((e) => e.kind === 'report')).toHaveLength(1);
  });

  it('returns target reports on done and removes them from the inbox', async () => {
    const sup = supervisorWithInstantReporters();
    sup.spawn('main', { role: 'scout', task: 'a' });
    sup.spawn('main', { role: 'scout', task: 'b' });
    await sup.whenIdle();

    const r = await sup.wait('main', [], 'all', { signal: new AbortController().signal });

    expect(r.reason).toBe('done');
    expect(r.reports.map((x) => x.summary)).toEqual(['s1 完成', 's2 完成']);
    expect(sup.mailbox('main')!.drainPeek().filter((e) => e.kind === 'report')).toHaveLength(0);
  });
});
