/**
 * Agent loop 集成测试：mock provider 回放录制好的 StreamChunk 序列，
 * 验证多步工具调用循环、UI 事件流、日志完整性与投影一致性。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../../src/agent/loop.js';
import { SystemPromptAssembler } from '../../src/agent/system-prompt.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import { RunLogWriter } from '../../src/session/log-writer.js';
import { loadRunLog, deriveMessages } from '../../src/session/projection.js';
import { createDefaultToolRegistry, MapToolServices } from '../../src/tools/index.js';
import { ScriptedProvider as MockAdapter, type Script } from '../fixtures/scripted-provider.js';
import { textScript, toolCallScript } from '../fixtures/chunks.js';

async function setup(scripts: Script[]) {
  const dir = mkdtempSync(path.join(tmpdir(), 'roast-loop-'));
  const adapter = new MockAdapter(scripts);
  const providers = new ProviderRegistry();
  providers.register('mock', adapter);
  const log = await RunLogWriter.create(path.join(dir, 'logs'), { cwd: dir, provider: 'mock', model: 'mock-1' });
  const loop = new AgentLoop({
    providers,
    modelRef: { provider: 'mock', model: 'mock-1' },
    tools: createDefaultToolRegistry(),
    systemPrompt: new SystemPromptAssembler(),
    log,
    cwd: dir,
    services: new MapToolServices(),
  });
  return { dir, adapter, log, loop };
}

async function collect(gen: AsyncGenerator<{ type: string }>) {
  const events = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe('AgentLoop', () => {
  it('无工具调用：单步完成 turn', async () => {
    const { adapter, loop } = await setup([textScript('你好')]);
    const events = await collect(loop.run('hi'));
    expect(events.map((e) => e.type)).toEqual(['turn-start', 'text-delta', 'usage', 'stream-commit', 'turn-end']);
    expect(events.at(-1)).toMatchObject({ reason: 'completed', usage: { input: 10, output: 5 } });
    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0]!.messages.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
  });

  it('多步：工具调用 → 结果回喂 → 再请求', async () => {
    const { dir, adapter, log, loop } = await setup([toolCallScript('c1', 'read', { path: 'a.txt' }), textScript('读完了')]);
    writeFileSync(path.join(dir, 'a.txt'), 'hello world\n', 'utf8');

    const events = await collect(loop.run('读一下 a.txt'));
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      'turn-start',
      'usage',
      'stream-commit',
      'tool-call-start',
      'tool-call-end',
      'text-delta',
      'usage',
      'stream-commit',
      'turn-end',
    ]);
    expect(events.at(-1)).toMatchObject({ reason: 'completed', usage: { input: 30, output: 13 } });

    // 第二次请求应携带工具结果
    const req2 = adapter.requests[1]!;
    const last = req2.messages.at(-1)!;
    expect(last.role).toBe('user');
    expect(last.content[0]).toMatchObject({ type: 'tool-result', toolCallId: 'c1', name: 'read' });

    // 日志完整且可投影
    const { events: logEvents } = loadRunLog(log.path);
    const types2 = new Set(logEvents.map((e) => e.type));
    for (const t of ['turn/start', 'user/message', 'request/digest', 'assistant/message', 'tool/call', 'tool/result', 'turn/end']) {
      expect(types2.has(t as never), `日志缺 ${t}`).toBe(true);
    }
    const projected = deriveMessages(logEvents);
    // user → assistant(tool-call) → user(tool-result) → assistant(text)
    expect(projected.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    // 投影应复现第二次请求发出的历史（结构匹配；isError 等默认值字段允许显隐差异）
    expect(projected.slice(0, req2.messages.length)).toMatchObject(req2.messages as object[]);
  });

  it('模型流错误：error 事件 + turn-end error', async () => {
    const { loop } = await setup([
      [{ type: 'finish', reason: 'error', error: Object.assign(new Error('boom'), { name: 'RoastError', code: 'SERVER' }) as never }],
    ]);
    const events = await collect(loop.run('hi'));
    expect(events.map((e) => e.type)).toEqual(['turn-start', 'usage', 'stream-reset', 'error', 'turn-end']);
    expect(events.at(-1)).toMatchObject({ reason: 'error' });
  });

  it('maxSteps 上限', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'roast-loop-'));
    writeFileSync(path.join(dir, 'x.txt'), 'x\n', 'utf8');
    const scripts = Array.from({ length: 5 }, (_, i) => toolCallScript(`c${i}`, 'read', { path: 'x.txt' }));
    const adapter = new MockAdapter(scripts);
    const providers = new ProviderRegistry();
    providers.register('mock', adapter);
    const log = await RunLogWriter.create(path.join(dir, 'logs'), { cwd: dir, provider: 'mock', model: 'mock-1' });
    const loop = new AgentLoop({
      providers,
      modelRef: { provider: 'mock', model: 'mock-1' },
      tools: createDefaultToolRegistry(),
      systemPrompt: new SystemPromptAssembler(),
      log,
      cwd: dir,
      services: new MapToolServices(),
      maxSteps: 2,
    });
    const events = await collect(loop.run('循环'));
    expect(adapter.requests).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: 'turn-end', reason: 'max-steps' });
    // 日志里也应有 max-steps 记录
    const content = readFileSync(log.path, 'utf8');
    expect(content).toContain('"max-steps"');
  });
});

describe('AgentLoop 日志可重放', () => {
  it('多步工具调用：每次请求的 viewHash 与日志折叠一致', async () => {
    const { replayMismatches } = await import('../fixtures/replay.js');
    const { dir, log, loop } = await setup([toolCallScript('c1', 'read', { path: 'a.txt' }), textScript('ok')]);
    writeFileSync(path.join(dir, 'a.txt'), 'x\n', 'utf8');
    for await (const _ of loop.run('读')) {
      // drain
    }
    expect(replayMismatches(log.path)).toEqual([]);
  });
});
