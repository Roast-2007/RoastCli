/**
 * resume：v1 续写同一日志（seq 接续、历史一致、edit 先读后改状态保留）；v0 导入历史。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../../src/agent/runtime.js';
import { SystemPromptAssembler } from '../../src/agent/system-prompt.js';
import type { UiEvent } from '../../src/agent/ui-events.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import { loadRunLog } from '../../src/session/projection.js';
import { findLatestRunFor, openRunLog } from '../../src/session/resume.js';
import { createDefaultToolRegistry, FS_STATE_KEY, FileStateStore, MapToolServices } from '../../src/tools/index.js';
import { ScriptedProvider, type Script } from '../fixtures/scripted-provider.js';
import { textScript, toolCallScript } from '../fixtures/chunks.js';
import { tempWorkspace } from '../fixtures/workspace.js';
import { replayMismatches } from '../fixtures/replay.js';
import { pairingErrors } from '../fixtures/history.js';

async function drain(gen: AsyncGenerator<UiEvent>): Promise<UiEvent[]> {
  const out: UiEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

async function start(dir: string, scripts: Script[], resumeLogPath?: string) {
  const provider = new ScriptedProvider(scripts);
  const providers = new ProviderRegistry();
  providers.register('p', provider);
  const opened = await openRunLog({
    logsRoot: path.join(dir, 'logs'),
    info: { cwd: dir, provider: 'p', model: 'm' },
    ...(resumeLogPath ? { resumeLogPath } : {}),
  });
  const services = new MapToolServices();
  const store = new FileStateStore();
  for (const [p, s] of opened.fileStates) store.record(p, s);
  services.set(FS_STATE_KEY, store);
  const rt = new AgentRuntime({
    providers,
    modelRef: { provider: 'p', model: 'm' },
    tools: createDefaultToolRegistry(),
    systemPrompt: new SystemPromptAssembler(),
    log: opened.log,
    cwd: dir,
    services,
    initialHistory: opened.initialHistory,
  });
  opened.finalize((b) => rt.committer.commit(b as never));
  return { rt, provider, opened };
}

describe('resume（v1）', () => {
  it('续写同一日志：历史带入下一次请求，edit 无需重新 read，日志整体可重放', async () => {
    const ws = tempWorkspace('roast-resume-');
    ws.file('a.txt', 'hello world\n');
    const first = await start(ws.dir, [toolCallScript('c1', 'read', { path: 'a.txt' }), textScript('读完了')]);
    await drain(first.rt.run('读 a.txt'));
    await first.opened.log.close();
    const logPath = first.opened.log.path;

    const second = await start(
      ws.dir,
      [toolCallScript('c2', 'edit', { path: 'a.txt', old_string: 'world', new_string: 'roast' }), textScript('改好了')],
      logPath,
    );
    expect(second.opened.resumedFrom).toEqual({ runId: first.opened.log.header.runId, messageCount: 4 });
    expect(second.opened.log.path).toBe(logPath);
    const events = await drain(second.rt.run('把 world 改成 roast'));
    expect(events.at(-1)).toMatchObject({ type: 'turn-end', reason: 'completed' });
    expect(readFileSync(path.join(ws.dir, 'a.txt'), 'utf8')).toBe('hello roast\n');

    const req = second.provider.requests[0]!;
    expect(req.messages).toHaveLength(5); // 旧 4 条 + 新 user
    expect(pairingErrors(req.messages)).toEqual([]);

    const all = loadRunLog(logPath).events;
    const seqs = all.map((e) => e.seq!);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(all.map((e) => e.type)).toContain('session/resume');
    expect(all.filter((e) => e.type === 'turn/start').map((e) => (e as { turn: number }).turn)).toEqual([1, 2]);
    expect(replayMismatches(logPath)).toEqual([]);
  });

  it('resume 后的下一次请求与不中断运行时发出的请求完全一致', async () => {
    const scripts = (): Script[] => [toolCallScript('c1', 'read', { path: 'a.txt' }), textScript('读完了'), textScript('第二轮')];
    const wsA = tempWorkspace('roast-eqA-');
    wsA.file('a.txt', 'x\n');
    const continuous = await start(wsA.dir, scripts());
    await drain(continuous.rt.run('第一问'));
    await drain(continuous.rt.run('第二问'));

    const wsB = tempWorkspace('roast-eqB-');
    wsB.file('a.txt', 'x\n');
    const s1 = await start(wsB.dir, scripts().slice(0, 2));
    await drain(s1.rt.run('第一问'));
    await s1.opened.log.close();
    const s2 = await start(wsB.dir, scripts().slice(2), s1.opened.log.path);
    await drain(s2.rt.run('第二问'));

    // 工作区路径不同会出现在 read 结果里，统一替换后比较
    const norm = (v: unknown, dir: string) => JSON.stringify(v).split(JSON.stringify(dir).slice(1, -1)).join('<WS>');
    expect(norm(s2.provider.requests[0]!.messages, wsB.dir)).toBe(norm(continuous.provider.requests[2]!.messages, wsA.dir));
  });

  it('findLatestRunFor 按 cwd 找最近一次运行', async () => {
    const ws = tempWorkspace('roast-latest-');
    const a = await start(ws.dir, [textScript('1')]);
    await drain(a.rt.run('x'));
    await a.opened.log.close();
    const found = findLatestRunFor(path.join(ws.dir, 'logs'), ws.dir);
    expect(found?.runId).toBe(a.opened.log.header.runId);
    expect(findLatestRunFor(path.join(ws.dir, 'logs'), path.join(ws.dir, 'other'))).toBeNull();
  });
});

describe('resume（v0 旧日志）', () => {
  it('新开 v1 日志并以 history/import 导入历史', async () => {
    const ws = tempWorkspace('roast-resume0-');
    const v0 = path.join(ws.dir, 'old.jsonl');
    const header = { type: 'session', version: 0, runId: 'old-run', createdAt: 't', cwd: ws.dir, provider: 'p', model: 'm', pid: 1 };
    const lines = [
      header,
      { type: 'turn/start', turn: 1, at: 't' },
      { type: 'user/message', turn: 1, at: 't', message: { role: 'user', content: [{ type: 'text', text: '旧问题' }] } },
      { type: 'assistant/message', turn: 1, step: 1, at: 't', message: { role: 'assistant', content: [{ type: 'text', text: '旧回答' }] } },
      { type: 'turn/end', turn: 1, at: 't', reason: 'completed' },
    ];
    writeFileSync(v0, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');

    const s = await start(ws.dir, [textScript('新回答')], v0);
    expect(s.opened.log.path).not.toBe(v0);
    await drain(s.rt.run('新问题'));
    const req = s.provider.requests[0]!;
    expect(req.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(loadRunLog(s.opened.log.path).events.map((e) => e.type)).toContain('history/import');
    expect(replayMismatches(s.opened.log.path)).toEqual([]);
  });
});
