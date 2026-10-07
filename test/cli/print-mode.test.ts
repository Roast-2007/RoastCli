/**
 * 管道模式（runPrintMode）的输出格式与退出码语义测试。
 * 用 mock loop（手工构造 UiEvent 数组的 async generator）+ 字符串 sink。
 */
import { describe, expect, it } from 'vitest';
import { RoastError } from '../../src/core/errors.js';
import { emptyUsage, type TokenUsage } from '../../src/core/types.js';
import type { UiEvent } from '../../src/agent/ui-events.js';
import { runPrintMode, type PrintLoop, type WritableLike } from '../../src/cli/print-mode.js';

function mockLoop(events: UiEvent[]): PrintLoop {
  return {
    async *run() {
      yield* events;
    },
  };
}

interface Sink extends WritableLike {
  text(): string;
}

function sink(): Sink {
  let buf = '';
  return {
    write(chunk: string) {
      buf += chunk;
    },
    text: () => buf,
  };
}

const usage = (input: number, output: number): TokenUsage => ({ input, output, cacheRead: 0, cacheWrite: 0 });

describe('runPrintMode', () => {
  it('text-delta 直接写 stdout，turn-end completed 退出码 0', async () => {
    const out = sink();
    const err = sink();
    const code = await runPrintMode(
      mockLoop([
        { type: 'text-delta', text: 'hello' },
        { type: 'text-delta', text: ' world' },
        { type: 'usage', usage: usage(3, 2) },
        { type: 'turn-end', reason: 'completed', usage: usage(3, 2) },
      ]),
      'hi',
      out,
      err,
    );
    expect(out.text()).toBe('hello world\n');
    expect(err.text()).toBe('');
    expect(code).toBe(0);
  });

  it('reasoning-delta 不输出', async () => {
    const out = sink();
    const code = await runPrintMode(
      mockLoop([
        { type: 'reasoning-delta', text: 'think…' },
        { type: 'text-delta', text: 'answer' },
        { type: 'turn-end', reason: 'completed', usage: emptyUsage() },
      ]),
      'hi',
      out,
      sink(),
    );
    expect(out.text()).toBe('answer\n');
    expect(code).toBe(0);
  });

  it('tool-call-start/end 输出指定行格式，且在流式文本前补换行', async () => {
    const out = sink();
    const code = await runPrintMode(
      mockLoop([
        { type: 'text-delta', text: 'let me check' },
        { type: 'tool-call-start', callId: 'c1', name: 'read_file', args: { path: 'a.ts' } },
        { type: 'tool-call-end', callId: 'c1', name: 'read_file', isError: false, preview: 'file content', durationMs: 12 },
        { type: 'text-delta', text: 'done' },
        { type: 'turn-end', reason: 'completed', usage: emptyUsage() },
      ]),
      'hi',
      out,
      sink(),
    );
    expect(out.text()).toBe('let me check\n> tool: read_file · a.ts\n  ✓ file content\ndone\n');
    expect(code).toBe(0);
  });

  it('工具错误打 ✗', async () => {
    const out = sink();
    await runPrintMode(
      mockLoop([
        { type: 'tool-call-start', callId: 'c1', name: 'bash', args: {} },
        { type: 'tool-call-end', callId: 'c1', name: 'bash', isError: true, preview: 'boom', durationMs: 3 },
        { type: 'turn-end', reason: 'completed', usage: emptyUsage() },
      ]),
      'hi',
      out,
      sink(),
    );
    expect(out.text()).toBe('> tool: bash\n  ✗ boom\n');
  });

  it('error 事件写 stderr 且退出码非零', async () => {
    const out = sink();
    const err = sink();
    const code = await runPrintMode(
      mockLoop([
        { type: 'text-delta', text: 'partial' },
        { type: 'error', error: new RoastError('RATE_LIMIT', 'too many') },
        { type: 'turn-end', reason: 'error', usage: emptyUsage() },
      ]),
      'hi',
      out,
      err,
    );
    expect(err.text()).toBe('error [RATE_LIMIT] too many\n');
    expect(code).toBe(1);
  });

  it('只有丢弃了已写出的文本才提示重试；无输出的失败与中断文本不额外提示', async () => {
    const err = sink();
    await runPrintMode(
      mockLoop([
        { type: 'reasoning-delta', text: 'think' },
        { type: 'stream-reset' },
        { type: 'error', error: new RoastError('UNKNOWN', 'boom') },
        { type: 'turn-end', reason: 'error', usage: emptyUsage() },
      ]),
      'hi',
      sink(),
      err,
    );
    expect(err.text()).toBe('error [UNKNOWN] boom\n');
    const out = sink(), retried = sink();
    await runPrintMode(
      mockLoop([
        { type: 'text-delta', text: 'half' },
        { type: 'stream-reset' },
        { type: 'text-delta', text: 'full' },
        { type: 'stream-commit' },
        { type: 'text-delta', text: ' cut' },
        { type: 'partial', text: ' cut' },
        { type: 'turn-end', reason: 'aborted', usage: emptyUsage() },
      ]),
      'hi',
      out,
      retried,
    );
    expect(out.text()).toBe('half\nfull cut\n');
    expect(retried.text()).toBe('[流中断，已丢弃部分输出，重试中]\n');
  });

  it('aborted / max-steps 退出码非零', async () => {
    for (const reason of ['aborted', 'max-steps'] as const) {
      const code = await runPrintMode(
        mockLoop([{ type: 'turn-end', reason, usage: emptyUsage() }]),
        'hi',
        sink(),
        sink(),
      );
      expect(code).toBe(1);
    }
  });
});

describe('runStreamJson', () => {
  it('主会话与子 agent 事件逐行输出为 JSON', async () => {
    const { runStreamJson } = await import('../../src/cli/print-mode.js');
    let emit: (id: string, ev: { type: 'notice'; text: string }) => void = () => {};
    const session = {
      loop: {
        async *run() {
          emit('w1', { type: 'notice', text: '子 agent 在工作' });
          yield { type: 'text-delta' as const, text: 'hi' };
          yield { type: 'turn-end' as const, reason: 'completed' as const, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
        },
      },
      onAgentEvent(l: typeof emit) {
        emit = l;
        return () => {};
      },
    };
    const lines: string[] = [];
    const code = await runStreamJson(session as never, 'go', { write: (s: string) => lines.push(s) });
    expect(code).toBe(0);
    const parsed = lines.join('').trim().split('\n').map((l) => JSON.parse(l));
    expect(parsed.map((p) => p.agent)).toEqual(['w1', 'main', 'main']);
    expect(parsed[1].event).toEqual({ type: 'text-delta', text: 'hi' });
  });
});
