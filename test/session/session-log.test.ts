import { mkdtempSync, rmSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RoastError } from '../../src/core/errors.js';
import type { Message } from '../../src/core/types.js';
import { LOG_FORMAT_VERSION } from '../../src/session/events.js';
import type { LogHeader, SessionEvent } from '../../src/session/events.js';
import { RunLogWriter } from '../../src/session/log-writer.js';
import { deriveMessages, loadRunLog } from '../../src/session/projection.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'roast-session-test-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const INFO = { cwd: 'D:\\work\\demo', provider: 'anthropic', model: 'claude-test' };

describe('RunLogWriter → loadRunLog 往返', () => {
  it('create 创建目录与 header，append 各类型事件后可完整还原', async () => {
    const writer = await RunLogWriter.create(tmp, INFO);

    // 目录结构 <logsRoot>/<YYYYMMDD>/<runId>/log.jsonl
    expect(writer.dir).toBe(path.join(tmp, writer.header.runId.slice(0, 8), writer.header.runId));
    expect(writer.path).toBe(path.join(writer.dir, 'log.jsonl'));
    expect(writer.header.runId).toMatch(/^\d{8}-\d{6}-[0-9a-f]{6}$/);

    const events: SessionEvent[] = [
      { type: 'turn/start', turn: 1, at: '2026-09-01T08:12:14.000Z' },
      { type: 'step/start', turn: 1, step: 1, at: '2026-09-01T08:12:14.100Z' },
      {
        type: 'user/message',
        turn: 1,
        at: '2026-09-01T08:12:14.000Z',
        message: { role: 'user', content: [{ type: 'text', text: '你好' }] },
      },
      {
        type: 'assistant/chunk',
        turn: 1,
        step: 1,
        chunk: { type: 'block-start', index: 0, block: 'text' },
      },
      {
        type: 'assistant/chunk',
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: '你好！' },
      },
      {
        type: 'assistant/message',
        turn: 1,
        step: 1,
        at: '2026-09-01T08:12:15.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: '你好！' }] },
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        finishReason: 'stop',
      },
      {
        type: 'tool/call',
        turn: 1,
        step: 1,
        at: '2026-09-01T08:12:15.100Z',
        callId: 'call-1',
        name: 'read_file',
        args: { path: 'a.ts' },
      },
      {
        type: 'tool/result',
        turn: 1,
        step: 1,
        at: '2026-09-01T08:12:15.200Z',
        callId: 'call-1',
        name: 'read_file',
        isError: false,
        content: [{ type: 'text', text: 'file content' }],
        durationMs: 12,
      },
      { type: 'usage', turn: 1, step: 1, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } },
      {
        type: 'error',
        at: '2026-09-01T08:12:16.000Z',
        where: 'provider',
        code: 'NETWORK',
        message: 'boom',
      },
      { type: 'turn/end', turn: 1, at: '2026-09-01T08:12:16.100Z', reason: 'completed' },
    ];
    for (const ev of events) writer.append(ev);
    await writer.close();

    const { header, events: loaded } = loadRunLog(writer.path);
    expect(header).toEqual(writer.header);
    expect(header.version).toBe(LOG_FORMAT_VERSION);
    expect(loaded).toEqual(events.map((e, i) => ({ ...e, seq: i + 1, agentId: 'main' })));
  });

  it('序列化失败的事件写成 error 兜底行，不抛出', async () => {
    const writer = await RunLogWriter.create(tmp, INFO);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    // 故意构造无法 JSON.stringify 的事件
    const bad = { type: 'usage', turn: 1, step: 1, usage: circular } as unknown as SessionEvent;
    expect(() => writer.append(bad)).not.toThrow();
    await writer.close();

    const { events } = loadRunLog(writer.path);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', where: 'log-writer' });
  });
});

describe('deriveMessages', () => {
  it('一轮含两个工具调用的会话投影为 user → assistant(tool-calls) → user(tool-results) → assistant(text)', () => {
    const header: LogHeader = {
      type: 'session',
      version: LOG_FORMAT_VERSION,
      runId: 'r',
      createdAt: '2026-09-01T08:12:14.000Z',
      cwd: '/x',
      provider: 'p',
      model: 'm',
      pid: 1,
    };
    const userMsg: Message = { role: 'user', content: [{ type: 'text', text: '读两个文件' }] };
    const assistantToolMsg: Message = {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          id: 'call-1',
          name: 'read_file',
          args: { path: 'a.ts' },
        },
        {
          type: 'tool-call',
          id: 'call-2',
          name: 'read_file',
          args: { path: 'b.ts' },
        },
      ],
    };
    const assistantTextMsg: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: '两个文件都读完了' }],
    };

    const events: (LogHeader | SessionEvent)[] = [
      header,
      { type: 'turn/start', turn: 1, at: 't' },
      { type: 'user/message', turn: 1, at: 't', message: userMsg },
      { type: 'step/start', turn: 1, step: 1, at: 't' },
      // chunk / usage 应被忽略
      { type: 'assistant/chunk', turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '...' } },
      { type: 'assistant/message', turn: 1, step: 1, at: 't', message: assistantToolMsg },
      { type: 'tool/call', turn: 1, step: 1, at: 't', callId: 'call-1', name: 'read_file', args: {} },
      { type: 'tool/call', turn: 1, step: 1, at: 't', callId: 'call-2', name: 'read_file', args: {} },
      {
        type: 'tool/result',
        turn: 1,
        step: 1,
        at: 't',
        callId: 'call-1',
        name: 'read_file',
        isError: false,
        content: [{ type: 'text', text: 'A' }],
        durationMs: 1,
      },
      {
        type: 'tool/result',
        turn: 1,
        step: 1,
        at: 't',
        callId: 'call-2',
        name: 'read_file',
        isError: true,
        content: [{ type: 'text', text: 'not found' }],
        durationMs: 2,
      },
      { type: 'usage', turn: 1, step: 1, usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
      { type: 'step/start', turn: 1, step: 2, at: 't' },
      { type: 'assistant/message', turn: 1, step: 2, at: 't', message: assistantTextMsg },
      { type: 'turn/end', turn: 1, at: 't', reason: 'completed' },
    ];

    const messages = deriveMessages(events);
    expect(messages).toHaveLength(4);

    expect(messages[0]).toBe(userMsg);
    expect(messages[1]).toBe(assistantToolMsg);

    // 同一 step 的两个 tool-result 合并进一条 user 消息，按 callId 出现顺序
    const toolResultMsg = messages[2];
    expect(toolResultMsg?.role).toBe('user');
    expect(toolResultMsg?.content).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        name: 'read_file',
        content: [{ type: 'text', text: 'A' }],
      },
      {
        type: 'tool-result',
        toolCallId: 'call-2',
        name: 'read_file',
        content: [{ type: 'text', text: 'not found' }],
        isError: true,
      },
    ]);

    expect(messages[3]).toBe(assistantTextMsg);
  });

  it('不同 step 的 tool-result 不合并', () => {
    const mk = (step: number, callId: string): SessionEvent => ({
      type: 'tool/result',
      turn: 1,
      step,
      at: 't',
      callId,
      name: 'read_file',
      isError: false,
      content: [{ type: 'text', text: callId }],
      durationMs: 1,
    });
    const messages = deriveMessages([mk(1, 'a'), mk(2, 'b')]);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content[0]).toMatchObject({ toolCallId: 'a' });
    expect(messages[1]?.content[0]).toMatchObject({ toolCallId: 'b' });
  });
});

describe('loadRunLog 容错与校验', () => {
  const headerLine = JSON.stringify({
    type: 'session',
    version: LOG_FORMAT_VERSION,
    runId: 'r',
    createdAt: 't',
    cwd: '/x',
    provider: 'p',
    model: 'm',
    pid: 1,
  });
  const eventLine = JSON.stringify({ type: 'turn/start', turn: 1, at: 't' });

  it('容忍末尾截断行（torn line）', async () => {
    const writer = await RunLogWriter.create(tmp, INFO);
    writer.append({ type: 'turn/start', turn: 1, at: 't' });
    writer.flush();
    // 模拟崩溃：手动 append 半行 JSON（不带换行）
    appendFileSync(writer.path, '{"type":"turn/en');
    await writer.close();

    const { events } = loadRunLog(writer.path);
    expect(events).toEqual([{ type: 'turn/start', turn: 1, at: 't', seq: 1, agentId: 'main' }]);
  });

  it('中间的损坏行仍然抛错', () => {
    const logPath = path.join(tmp, 'bad-mid.jsonl');
    appendFileSync(logPath, `${headerLine}\nnot-json\n${eventLine}\n`);
    expect(() => loadRunLog(logPath)).toThrowError(RoastError);
    expect(() => loadRunLog(logPath)).toThrowError(/第 2 行/);
  });

  it('version 不匹配抛 RoastError(CONFIG)', async () => {
    const writer = await RunLogWriter.create(tmp, INFO);
    const raw = readFileSync(writer.path, 'utf8');
    const header = JSON.parse(raw.split('\n')[0]!) as Record<string, unknown>;
    header.version = 999;
    const badPath = path.join(tmp, 'bad-version.jsonl');
    appendFileSync(badPath, JSON.stringify(header) + '\n');

    try {
      loadRunLog(badPath);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(RoastError);
      expect((err as RoastError).code).toBe('CONFIG');
      expect((err as RoastError).message).toMatch(/版本不匹配/);
    }
  });

  it('未知事件类型抛 RoastError(CONFIG)', () => {
    const logPath = path.join(tmp, 'unknown.jsonl');
    appendFileSync(logPath, `${headerLine}\n${JSON.stringify({ type: 'future/event' })}\n`);
    try {
      loadRunLog(logPath);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(RoastError);
      expect((err as RoastError).code).toBe('CONFIG');
      expect((err as RoastError).message).toMatch(/未知事件类型/);
    }
  });

  it('首行不是 header 抛错', () => {
    const logPath = path.join(tmp, 'no-header.jsonl');
    appendFileSync(logPath, `${eventLine}\n`);
    expect(() => loadRunLog(logPath)).toThrowError(/header/);
  });
});
