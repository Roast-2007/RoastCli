import { describe, expect, it } from 'vitest';
import { createSession } from '../../src/agent/session.js';
import { ConfigSchema } from '../../src/core/config.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import { deriveDisplayMessages, loadRunLog } from '../../src/session/projection.js';
import { replayView } from '../../src/ui/store/reducer.js';
import { loadStrategies, missionInput } from '../../src/swarm/strategies.js';
import { extractSummary } from '../../src/context/compactor.js';
import { runStreamJson, runPrintMode } from '../../src/cli/print-mode.js';
import { ScriptedProvider } from '../fixtures/scripted-provider.js';
import { RoutedProvider } from '../fixtures/routed-provider.js';
import { textScript, toolCallScript } from '../fixtures/chunks.js';
import { tempWorkspace } from '../fixtures/workspace.js';
import { replayMismatches } from '../fixtures/replay.js';
import { pairingErrors } from '../fixtures/history.js';
import { promptSubmitGuard } from '../../src/ext/hooks/integration.js';
import { vi } from 'vitest';

const config = ConfigSchema.parse({ providers: { p: { driver: 'openai-compat', auth: 'none' } }, default: 'p:m', swarm: { worktrees: false } });
const drain = async (stream: AsyncGenerator<unknown>) => { for await (const _ of stream) {} };

describe('Hive mission event', () => {
  it('passes goal and Hive metadata to the submit hook, logs appended context and respects blocking', async () => {
    const ws = tempWorkspace(), providers = new ProviderRegistry();
    const provider = new ScriptedProvider([textScript('ok')]);
    providers.register('p', provider);
    const guard = vi.fn().mockResolvedValueOnce({ action: 'sanitize', sanitized: 'goal\n\nextra context' }).mockResolvedValueOnce({ action: 'block', reason: 'no' });
    const session = await createSession({ cwd: ws.dir, config, providers, extensions: { inputGuard: { check: guard } } });
    const input = missionInput(loadStrategies(ws.dir, ws.dir), 'goal', 'research');
    await drain(session.loop.run(input));
    expect(guard).toHaveBeenCalledWith('goal', 'user', { signal: expect.any(AbortSignal), hive: { strategy: 'research', n: 3 } });
    expect(JSON.stringify(provider.requests[0]!.messages)).toContain('extra context');
    await drain(session.loop.run(input));
    expect(provider.requests).toHaveLength(1);
    await session.shutdown();
    expect(loadRunLog(session.log.path).events.filter((e) => e.type === 'hive/mission')).toHaveLength(1);
    const runner = { has: () => true, run: vi.fn(async () => ({ errors: [], output: 'hook context' })) };
    const hook = promptSubmitGuard(runner as never, () => {});
    expect(await hook.check('goal', 'user', { hive: { strategy: 'research', n: 3 } })).toMatchObject({ action: 'sanitize', sanitized: expect.stringContaining('hook context') });
    expect(runner.run).toHaveBeenCalledWith('UserPromptSubmit', { prompt: 'goal', hive: { strategy: 'research', n: 3 } }, {});
  });
  it('keeps interrupted mission tool calls paired and restores queued input', async () => {
    const ws = tempWorkspace(), providers = new ProviderRegistry();
    const provider = new ScriptedProvider([toolCallScript('read', 'read', { path: 'a.txt' }), textScript('done')]);
    ws.file('a.txt', 'content');
    providers.register('p', provider);
    const session = await createSession({ cwd: ws.dir, config, providers });
    const abort = new AbortController();
    let restored: string[] = [];
    for await (const event of session.loop.run(missionInput(loadStrategies(ws.dir, ws.dir), 'read'), abort.signal)) {
      if (event.type === 'tool-call-start') { session.loop.enqueue('queued'); abort.abort(); }
      if (event.type === 'queue-restored') restored = event.texts;
    }
    expect(restored).toEqual(['queued']);
    expect(pairingErrors([...session.loop.committer.messages()])).toEqual([]);
    await session.shutdown();
    expect(replayMismatches(session.log.path)).toEqual([]);
  });
  it('logs the rendered brief once, projects only the goal, restores ids and replays requests', async () => {
    const ws = tempWorkspace();
    const providers = new ProviderRegistry();
    const provider = new ScriptedProvider([textScript('完成'), textScript('继续')]);
    providers.register('p', provider);
    const input = missionInput(loadStrategies(ws.dir, ws.dir), '中文目标', 'fanout');
    let session = await createSession({ cwd: ws.dir, config, providers });
    const log = session.log.path;
    let output = '';
    expect(await runPrintMode(session.loop, input, { write: (s) => { output += s; } }, { write: () => {} })).toBe(0);
    expect(output).toBe('完成\n');
    expect(JSON.stringify(provider.requests[0]!.messages)).toContain('You are the Queen');
    expect(session.listTurns()).toEqual([{ turn: 1, text: '中文目标' }]);
    await session.shutdown();
    const { events } = loadRunLog(log);
    expect(events.filter((e) => e.type === 'user/message')).toHaveLength(0);
    expect(events.find((e) => e.type === 'hive/mission')).toMatchObject({ missionId: 'm1', goal: '中文目标' });
    expect(JSON.stringify(deriveDisplayMessages(events))).not.toContain('You are the Queen');
    expect(replayView(events).items[0]).toMatchObject({ kind: 'mission', goal: '中文目标' });
    expect(extractSummary(provider.requests[0]!.messages)).toContain('用户请求（按时间）\n- 中文目标');
    expect(replayMismatches(log)).toEqual([]);
    session = await createSession({ cwd: ws.dir, config, providers, resumeLogPath: log });
    let json = '';
    expect(await runStreamJson(session, input, { write: (s) => { json += s; } })).toBe(0);
    expect(json.split('\n').filter(Boolean).map((line) => JSON.parse(line).event).find((e) => e.type === 'hive/mission').missionId).toBe('m2');
    expect(pairingErrors([...session.loop.committer.messages()])).toEqual([]);
    await session.shutdown();
    expect(replayMismatches(log)).toEqual([]);
  });
  it('associates delegated tasks without overriding a locked critic route', async () => {
    const ws = tempWorkspace();
    const providers = new ProviderRegistry();
    providers.register('p', new RoutedProvider({ main: [toolCallScript('spawn', 'spawn_agent', { role: 'critic', task: 'review', task_id: 't1' }), toolCallScript('wait', 'await_agents', {}), textScript('done')], c1: [toolCallScript('report', 'report', { status: 'done', summary: 'RESULT: ok\nCHANGES: none\nVERIFY: read\nRISKS: none' }), textScript('done')] }));
    const session = await createSession({ cwd: ws.dir, config: { ...config, swarm: { ...config.swarm, models: { critic: 'inherit' } } }, providers });
    await drain(session.loop.run(missionInput(loadStrategies(ws.dir, ws.dir), 'review')));
    expect(session.swarm.info('c1')).toMatchObject({ taskId: 't1', model: 'p:m' });
    expect(session.swarm.spawn('main', { role: 'critic', task: 'x', model: 'p:other' })).toMatchObject({ ok: false });
    await session.shutdown();
    expect(replayMismatches(session.log.path)).toEqual([]);
  });
});
