/**
 * resume 健壮性（M1 评审 #1 #2 #3 #6）：
 * - 工具阶段中途崩溃留下的未配对 tool-call：恢复时补合成结果
 * - 末尾残行：续写前截掉，日志保持可读
 * - 另一个进程仍在写该日志：分叉到新日志并导入历史
 * - findLatestRunFor 按最近写入时间选择
 */
import { appendFileSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../../src/agent/runtime.js';
import { SystemPromptAssembler } from '../../src/agent/system-prompt.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import { RunLogWriter } from '../../src/session/log-writer.js';
import { loadRunLog } from '../../src/session/projection.js';
import { findLatestRunFor, openRunLog } from '../../src/session/resume.js';
import { createDefaultToolRegistry, MapToolServices } from '../../src/tools/index.js';
import { ScriptedProvider, type Script } from '../fixtures/scripted-provider.js';
import { textScript } from '../fixtures/chunks.js';
import { tempWorkspace } from '../fixtures/workspace.js';
import { pairingErrors } from '../fixtures/history.js';
import { replayMismatches } from '../fixtures/replay.js';

const at = 't';

/** 手写一份 v1 日志：assistant 发起 tool-call 后进程崩溃（没有 tool/result） */
async function crashedLog(dir: string): Promise<string> {
  const log = await RunLogWriter.create(path.join(dir, 'logs'), { cwd: dir, provider: 'p', model: 'm' });
  log.append({ type: 'turn/start', turn: 1, at });
  log.append({ type: 'user/message', turn: 1, at, message: { role: 'user', content: [{ type: 'text', text: '改文件' }] } });
  log.append({
    type: 'assistant/message',
    turn: 1,
    step: 1,
    at,
    message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'bash', args: { command: 'sleep 100' } }] },
  });
  log.append({ type: 'tool/call', turn: 1, step: 1, at, callId: 'c1', name: 'bash', args: { command: 'sleep 100' } });
  log.flush();
  // 模拟崩溃：不 close，直接释放锁（进程已不存在）
  log.releaseLock();
  return log.path;
}

async function resumeAndRun(dir: string, logPath: string, scripts: Script[]) {
  const provider = new ScriptedProvider(scripts);
  const providers = new ProviderRegistry();
  providers.register('p', provider);
  const opened = await openRunLog({ logsRoot: path.join(dir, 'logs'), info: { cwd: dir, provider: 'p', model: 'm' }, resumeLogPath: logPath });
  const rt = new AgentRuntime({
    providers,
    modelRef: { provider: 'p', model: 'm' },
    tools: createDefaultToolRegistry(),
    systemPrompt: new SystemPromptAssembler(),
    log: opened.log,
    cwd: dir,
    services: new MapToolServices(),
    initialHistory: opened.initialHistory,
  });
  opened.finalize((b) => rt.committer.commit(b));
  for await (const _ of rt.run('继续')) {
    // drain
  }
  await opened.log.close();
  return { provider, opened };
}

describe('resume：未配对的工具调用', () => {
  it('v1：恢复时为悬空 tool-call 补合成结果，请求配对合法、日志可重放', async () => {
    const ws = tempWorkspace('roast-dangling-');
    const logPath = await crashedLog(ws.dir);
    const { provider } = await resumeAndRun(ws.dir, logPath, [textScript('好的')]);
    const req = provider.requests[0]!;
    expect(pairingErrors(req.messages)).toEqual([]);
    const synthetic = loadRunLog(logPath).events.find((e) => e.type === 'tool/result');
    expect(synthetic).toMatchObject({ callId: 'c1', isError: true, turn: 1, step: 1 });
    expect(replayMismatches(logPath)).toEqual([]);
  });

  it('v0：导入的历史同样补齐悬空调用', async () => {
    const ws = tempWorkspace('roast-dangling0-');
    const v0 = path.join(ws.dir, 'old.jsonl');
    const lines = [
      { type: 'session', version: 0, runId: 'old', createdAt: at, cwd: ws.dir, provider: 'p', model: 'm', pid: 1 },
      { type: 'user/message', turn: 1, at, message: { role: 'user', content: [{ type: 'text', text: 'x' }] } },
      { type: 'assistant/message', turn: 1, step: 1, at, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'z', name: 'read', args: {} }] } },
    ];
    writeFileSync(v0, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const { provider } = await resumeAndRun(ws.dir, v0, [textScript('ok')]);
    expect(pairingErrors(provider.requests[0]!.messages)).toEqual([]);
  });
});

describe('repairPairing', () => {
  it('部分调用已有结果：补齐缺失的，合并进同一条 user 消息，不改动其余消息', async () => {
    const { repairPairing } = await import('../../src/session/resume.js');
    const msgs = [
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'q' }] },
      {
        role: 'assistant' as const,
        content: [
          { type: 'tool-call' as const, id: 'a', name: 'read', args: {} },
          { type: 'tool-call' as const, id: 'b', name: 'read', args: {} },
        ],
      },
      { role: 'user' as const, content: [{ type: 'tool-result' as const, toolCallId: 'a', name: 'read', content: [] }] },
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'done' }] },
    ];
    const out = repairPairing(msgs);
    expect(out).toHaveLength(4);
    expect(pairingErrors(out)).toEqual([]);
    expect(out[3]).toBe(msgs[3]);
  });
});

describe('resume：日志文件状态', () => {
  it('末尾残行在续写前被截掉，日志保持可读', async () => {
    const ws = tempWorkspace('roast-torn-');
    const first = await resumeAndRunFresh(ws.dir);
    appendFileSync(first, '{"type":"turn/st');
    await resumeAndRun(ws.dir, first, [textScript('ok')]);
    const { events } = loadRunLog(first);
    const seqs = events.map((e) => e.seq!);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(readFileSync(first, 'utf8')).not.toContain('{"type":"turn/st{');
  });

  it('日志仍被另一个存活进程持有：分叉到新日志并导入历史', async () => {
    const ws = tempWorkspace('roast-lock-');
    const provider = new ScriptedProvider([]);
    const providers = new ProviderRegistry();
    providers.register('p', provider);
    const holder = await RunLogWriter.create(path.join(ws.dir, 'logs'), { cwd: ws.dir, provider: 'p', model: 'm' });
    holder.append({ type: 'user/message', turn: 1, at, message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } });
    holder.flush();
    const opened = await openRunLog({
      logsRoot: path.join(ws.dir, 'logs'),
      info: { cwd: ws.dir, provider: 'p', model: 'm' },
      resumeLogPath: holder.path,
    });
    expect(opened.log.path).not.toBe(holder.path);
    expect(opened.forkedFromLocked).toBe(true);
    expect(opened.initialHistory.messages).toEqual([]);
    const commits: string[] = [];
    opened.finalize((b) => commits.push(b.type));
    expect(commits).toContain('history/import');
    await opened.log.close();
    await holder.close();
  });
});

async function resumeAndRunFresh(dir: string): Promise<string> {
  const provider = new ScriptedProvider([textScript('1')]);
  const providers = new ProviderRegistry();
  providers.register('p', provider);
  const log = await RunLogWriter.create(path.join(dir, 'logs'), { cwd: dir, provider: 'p', model: 'm' });
  const rt = new AgentRuntime({
    providers,
    modelRef: { provider: 'p', model: 'm' },
    tools: createDefaultToolRegistry(),
    systemPrompt: new SystemPromptAssembler(),
    log,
    cwd: dir,
    services: new MapToolServices(),
  });
  for await (const _ of rt.run('first')) {
    // drain
  }
  await log.close();
  return log.path;
}

describe('findLatestRunFor', () => {
  it('按最近写入时间而非创建时间选择', async () => {
    const ws = tempWorkspace('roast-latest2-');
    const older = await resumeAndRunFresh(ws.dir);
    await new Promise((r) => setTimeout(r, 1100)); // runId 精度到秒
    const newer = await resumeAndRunFresh(ws.dir);
    const now = Date.now() / 1000;
    utimesSync(newer, now - 3600, now - 3600);
    utimesSync(older, now, now);
    expect(findLatestRunFor(path.join(ws.dir, 'logs'), ws.dir)?.logPath).toBe(older);
  });
});
