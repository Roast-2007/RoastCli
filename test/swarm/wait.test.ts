/**
 * Supervisor.wait 的边界语义：中断时不吞掉报告；done 时报告随结果返回且不重复投递。
 */
import { describe, expect, it, vi } from 'vitest';
import { formatProgress } from '../../src/swarm/progress.js';
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
  it('任意用户交互暂停 await 和成员运行时间，恢复后按剩余预算超时', async () => {
    const dir = tempWorkspace().dir;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const sup = new Supervisor({
      cwd: dir,
      mainLogPath: path.join(dir, 'log.jsonl'),
      runId: 'r',
      now: () => Date.now(),
      maxAgentMs: 2000,
      createServices: () => new MapToolServices(),
      modelFor: () => ({ provider: 'p', model: 'm' }),
      createRuntime: () =>
        ({
          setPaused() {},
          async *run(_prompt: string, signal: AbortSignal) {
            started();
            await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
            yield { type: 'turn-end', reason: 'aborted' };
          },
        }) as never,
    });
    sup.registerRoot('main', 'p:m');
    sup.spawn('main', { role: 'worker', task: 'task' });
    await ready;
    sup.setUserInteraction(true);
    vi.useFakeTimers();
    try {
      const waiting = sup.wait('main', [], 'all', { timeoutMs: 1000, signal: new AbortController().signal });
      let finished = false;
      void waiting.then(() => {
        finished = true;
      });
      sup.setUserInteraction(true);
      sup.setInteractionWaiting('w1', '等待用户授权');
      await vi.advanceTimersByTimeAsync(120_000);
      expect(finished).toBe(false);
      expect(sup.info('w1')?.report).toBeUndefined();
      sup.setUserInteraction(false);
      await vi.advanceTimersByTimeAsync(1000);
      const result = await waiting;
      expect(result).toMatchObject({ reason: 'timeout', progress: [{ id: 'w1', waitingFor: '等待用户授权' }] });
      expect(
        formatProgress({ ...result.progress![0]!, steps: 37, maxSteps: 150, lastActivityAt: Date.now() - 120_000, lastTool: 'bash' }),
      ).toContain('步骤 37/150 · 最近活动 2 分钟前 · 最近工具 bash · 等待用户授权');
      expect(sup.info('w1')?.report).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1000);
      await sup.whenIdle();
      expect(sup.info('w1')?.state).toBe('cancelled');
    } finally {
      sup.cancelSubtree('w1');
      vi.useRealTimers();
    }
  });
  it('reports runtime setup failures and completes the wait instead of leaving a live child', async () => {
    const dir = tempWorkspace().dir;
    const sup = new Supervisor({
      mainLogPath: path.join(dir, 'log.jsonl'),
      runId: 'r',
      cwd: dir,
      createServices: () => new MapToolServices(),
      modelFor: () => ({ provider: 'p', model: 'm' }),
      createRuntime: () => {
        throw new Error('provider setup failed');
      },
    });
    sup.registerRoot('main', 'p:m');
    sup.spawn('main', { role: 'scout', task: 'task' });
    await sup.whenIdle();
    expect(sup.info('s1')?.state).toBe('failed');
    const result = await sup.wait('main', [], 'all', { signal: new AbortController().signal });
    expect(result.reports[0]?.status).toBe('failed');
    expect(result.reports[0]?.summary).toContain('出错停止：provider setup failed');
  });
  it('leaves reports in the inbox when the wait is aborted', async () => {
    const sup = supervisorWithInstantReporters();
    sup.spawn('main', { role: 'scout', task: 'a' });
    await sup.whenIdle();
    const ac = new AbortController();
    ac.abort();

    const r = await sup.wait('main', [], 'all', { signal: ac.signal });

    expect(r.reason).toBe('aborted');
    expect(
      sup
        .mailbox('main')!
        .drainPeek()
        .filter((e) => e.kind === 'report'),
    ).toHaveLength(1);
  });

  it('returns target reports on done and removes them from the inbox', async () => {
    const sup = supervisorWithInstantReporters();
    sup.spawn('main', { role: 'scout', task: 'a' });
    sup.spawn('main', { role: 'scout', task: 'b' });
    await sup.whenIdle();

    const r = await sup.wait('main', [], 'all', { signal: new AbortController().signal });

    expect(r.reason).toBe('done');
    expect(r.reports.map((x) => x.summary)).toEqual(['s1 完成', 's2 完成']);
    expect(
      sup
        .mailbox('main')!
        .drainPeek()
        .filter((e) => e.kind === 'report'),
    ).toHaveLength(0);
  });
});
