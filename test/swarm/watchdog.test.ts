import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '../../src/session/events.js';
import { ProgressWatchdog } from '../../src/swarm/watchdog.js';

const at = '2026-01-01T00:00:00Z';
const start = (step: number): SessionEvent => ({ type: 'step/start', turn: 1, step, at });
function complete(watchdog: ProgressWatchdog, step: number, args: unknown, output: string, error = false, denied = false) {
  const alert = watchdog.observe(start(step));
  watchdog.observe({ type: 'assistant/message', turn: 1, step, at, message: { role: 'assistant', content: [] } });
  watchdog.observe({ type: 'tool/call', turn: 1, step, at, callId: `c${step}`, name: 'read', args });
  watchdog.observe({ type: 'tool/result', turn: 1, step, at, callId: `c${step}`, name: 'read', isError: error, content: [{ type: 'text', text: output }], durationMs: 1, metadata: { denied } });
  return alert;
}

describe('research progress watchdog', () => {
  it('counts new reads and changed results as progress without requiring file writes', () => {
    const watchdog = new ProgressWatchdog(() => 2);
    for (let step = 1; step <= 20; step++) {
      expect(complete(watchdog, step, { path: `src/${step}.ts` }, `file ${step}`)).toBeUndefined();
    }
    for (let step = 21; step <= 25; step++) {
      expect(complete(watchdog, step, { path: 'src/live.ts' }, `revision ${step}`)).toBeUndefined();
    }
    expect(watchdog.observe(start(26))).toBeUndefined();
  });

  it('alerts only after repeated unchanged results finish, even if argument keys are reordered', () => {
    const watchdog = new ProgressWatchdog(() => 2);
    complete(watchdog, 1, { path: 'a.ts', offset: 0 }, 'same result');
    expect(complete(watchdog, 2, { offset: 0, path: 'a.ts' }, 'same result')).toBeUndefined();
    expect(complete(watchdog, 3, { path: 'a.ts', offset: 0 }, 'same result')).toBeUndefined();
    expect(watchdog.observe(start(4))).toEqual({ steps: 2, denied: false });
    complete(watchdog, 4, { path: 'a.ts', offset: 0 }, 'same result');
    expect(watchdog.observe(start(5))).toBeUndefined();
  });

  it('counts a batch of denied tools as one step and identifies the permission block', () => {
    const watchdog = new ProgressWatchdog(() => 2);
    complete(watchdog, 1, {}, 'denied', true, true);
    for (let i = 0; i < 50; i++) watchdog.observe({ type: 'tool/result', turn: 1, step: 1, at, callId: `extra${i}`, name: 'bash', isError: true, content: [], durationMs: 1, metadata: { denied: true } });
    expect(complete(watchdog, 2, {}, 'denied', true, true)).toBeUndefined();
    expect(watchdog.observe(start(3))).toEqual({ steps: 2, denied: true });
  });

  it('does not count streaming usage, retries, or an unfinished approval wait as steps', () => {
    const watchdog = new ProgressWatchdog(() => 1);
    watchdog.observe(start(1));
    for (let attempt = 1; attempt <= 20; attempt++) {
      expect(watchdog.observe({ type: 'usage', turn: 1, step: 1, usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 } })).toBeUndefined();
      expect(watchdog.observe({ type: 'step/retry', turn: 1, step: 1, at, attempt, code: 'SERVER', message: 'retry', delayMs: 1 })).toBeUndefined();
      expect(watchdog.observe(start(1))).toBeUndefined();
    }
    expect(watchdog.observe(start(2))).toBeUndefined();
    watchdog.observe({ type: 'assistant/message', turn: 1, step: 2, at, message: { role: 'assistant', content: [] } });
    watchdog.observe({ type: 'tool/call', turn: 1, step: 2, at, callId: 'approval', name: 'bash', args: {} });
    expect(watchdog.observe({ type: 'usage', turn: 1, step: 2, usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 } })).toBeUndefined();
  });

  it('recovers after genuine progress and can detect a later stalled episode', () => {
    const watchdog = new ProgressWatchdog(() => 1);
    complete(watchdog, 1, { path: 'a.ts' }, 'a');
    complete(watchdog, 2, { path: 'a.ts' }, 'a');
    expect(complete(watchdog, 3, { path: 'b.ts' }, 'b')).toEqual({ steps: 1, denied: false });
    expect(complete(watchdog, 4, { path: 'b.ts' }, 'b')).toBeUndefined();
    expect(watchdog.observe(start(5))).toEqual({ steps: 1, denied: false });
  });
});
