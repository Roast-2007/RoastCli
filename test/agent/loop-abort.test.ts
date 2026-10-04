/**
 * 中断全链路：工具执行中途 abort，turn 必须优雅收尾（不挂起、不崩溃），
 * 每个 tool-call 都有落日志的结果（含执行中被中断的），历史配对合法，下一个 turn 可继续。
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentLoop } from '../../src/agent/loop.js';
import { SystemPromptAssembler } from '../../src/agent/system-prompt.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import { RunLogWriter } from '../../src/session/log-writer.js';
import { deriveMessages, loadRunLog } from '../../src/session/projection.js';
import { defineTool, MapToolServices, readTool, textResult, ToolRegistry } from '../../src/tools/index.js';
import type { UiEvent } from '../../src/agent/ui-events.js';
import { ScriptedProvider, type Script } from '../fixtures/scripted-provider.js';
import { textScript, toolCallsScript } from '../fixtures/chunks.js';
import { tempWorkspace } from '../fixtures/workspace.js';
import { pairingErrors } from '../fixtures/history.js';
import path from 'node:path';

/** 一直阻塞到 abort，然后像 bash 一样以 AbortError reject */
function blockingTool(onStart: () => void) {
  return defineTool({
    name: 'block',
    description: 'blocks until aborted',
    parameters: z.object({}),
    isReadOnly: false,
    isConcurrencySafe: false,
    async execute(_args, ctx) {
      onStart();
      await new Promise<void>((_resolve, reject) => {
        ctx.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
      return textResult('unreachable');
    },
  });
}

async function setup(scripts: Script[], onBlockStart: () => void) {
  const ws = tempWorkspace('roast-abort-');
  ws.file('a.txt', 'hello\n');
  const provider = new ScriptedProvider(scripts);
  const providers = new ProviderRegistry();
  providers.register('mock', provider);
  const tools = new ToolRegistry();
  tools.register(blockingTool(onBlockStart));
  tools.register(readTool);
  const log = await RunLogWriter.create(path.join(ws.dir, 'logs'), { cwd: ws.dir, provider: 'mock', model: 'm' });
  const loop = new AgentLoop({
    providers,
    modelRef: { provider: 'mock', model: 'm' },
    tools,
    systemPrompt: new SystemPromptAssembler(),
    log,
    cwd: ws.dir,
    services: new MapToolServices(),
  });
  return { provider, log, loop };
}

/** 收集事件；超时视为挂起 */
async function collectWithin(gen: AsyncGenerator<UiEvent>, ms: number): Promise<UiEvent[]> {
  const events: UiEvent[] = [];
  const drain = (async () => {
    for await (const e of gen) events.push(e);
  })();
  const timeout = new Promise<never>((_r, reject) => setTimeout(() => reject(new Error(`turn 在 ${ms}ms 内未结束（挂起）`)), ms));
  await Promise.race([drain, timeout]);
  return events;
}

describe('AgentLoop 中断', () => {
  it('工具执行中 abort：turn 以 aborted 收尾，执行中与未开始的调用都有合成结果', async () => {
    const controller = new AbortController();
    const { provider, log, loop } = await setup(
      [
        toolCallsScript([
          { id: 'c1', name: 'block', args: {} },
          { id: 'c2', name: 'read', args: { path: 'a.txt' } },
        ]),
        textScript('继续好了'),
      ],
      () => setTimeout(() => controller.abort(), 10),
    );

    const events = await collectWithin(loop.run('go', controller.signal), 3000);
    expect(events.at(-1)).toMatchObject({ type: 'turn-end', reason: 'aborted' });
    const ends = events.filter((e) => e.type === 'tool-call-end');
    expect(ends.map((e) => (e as { callId: string }).callId)).toContain('c1');

    const { events: logEvents } = loadRunLog(log.path);
    const results = logEvents.filter((e) => e.type === 'tool/result');
    expect(results.map((r) => (r as { callId: string }).callId).sort()).toEqual(['c1', 'c2']);
    expect(results.every((r) => (r as { isError: boolean }).isError)).toBe(true);
    expect(pairingErrors(deriveMessages(logEvents))).toEqual([]);

    // 下一个 turn 正常运行，且发出的历史配对合法
    const next = await collectWithin(loop.run('继续'), 3000);
    expect(next.at(-1)).toMatchObject({ type: 'turn-end', reason: 'completed' });
    const lastReq = provider.requests.at(-1)!;
    expect(pairingErrors(lastReq.messages)).toEqual([]);
  });

  it('工具执行中 abort 不产生未处理的 rejection', async () => {
    const rejections: unknown[] = [];
    const onRejection = (r: unknown) => rejections.push(r);
    process.on('unhandledRejection', onRejection);
    try {
      const controller = new AbortController();
      const { loop } = await setup(
        [toolCallsScript([{ id: 'c1', name: 'block', args: {} }])],
        () => setTimeout(() => controller.abort(), 10),
      );
      await collectWithin(loop.run('go', controller.signal), 3000);
      await new Promise((r) => setTimeout(r, 20));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});
