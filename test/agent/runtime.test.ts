/**
 * AgentRuntime 行为：插话排队与送达、中断时交还排队、边界注入、等待不耗 token、重试。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentRuntime, type AgentRuntimeDeps } from '../../src/agent/runtime.js';
import { SystemPromptAssembler } from '../../src/agent/system-prompt.js';
import type { UiEvent } from '../../src/agent/ui-events.js';
import { ProviderRegistry } from '../../src/providers/adapter.js';
import { RunLogWriter } from '../../src/session/log-writer.js';
import { loadRunLog } from '../../src/session/projection.js';
import { defineTool, MapToolServices, textResult, ToolRegistry } from '../../src/tools/index.js';
import { ScriptedProvider, type Script } from '../fixtures/scripted-provider.js';
import { errorScript, textScript, toolCallScript } from '../fixtures/chunks.js';
import { tempWorkspace } from '../fixtures/workspace.js';
import { FakeClock } from '../fixtures/fake-clock.js';
import { replayMismatches } from '../fixtures/replay.js';
import { RoastError } from '../../src/core/errors.js';

/** 可控工具：execute 等待外部 release，用于在工具执行期间插话 */
function gateTool() {
  let release: () => void = () => {};
  let started: () => void = () => {};
  const startedP = new Promise<void>((r) => (started = r));
  const tool = defineTool({
    name: 'gate',
    description: 'waits for release',
    parameters: z.object({}),
    isReadOnly: true,
    isConcurrencySafe: true,
    async execute() {
      started();
      await new Promise<void>((r) => (release = r));
      return textResult('released');
    },
  });
  return { tool, startedP, release: () => release() };
}

async function setup(scripts: Script[], extra: Partial<AgentRuntimeDeps> = {}, tools = new ToolRegistry()) {
  const ws = tempWorkspace('roast-rt-');
  const provider = new ScriptedProvider(scripts);
  const providers = new ProviderRegistry();
  providers.register('p', provider);
  const log = await RunLogWriter.create(path.join(ws.dir, 'logs'), { cwd: ws.dir, provider: 'p', model: 'm' });
  const rt = new AgentRuntime({
    providers,
    modelRef: { provider: 'p', model: 'm' },
    tools,
    systemPrompt: new SystemPromptAssembler(),
    log,
    cwd: ws.dir,
    services: new MapToolServices(),
    clock: new FakeClock(),
    random: () => 0.5,
    ...extra,
  });
  return { rt, provider, log };
}

async function collect(gen: AsyncGenerator<UiEvent>): Promise<UiEvent[]> {
  const out: UiEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const lastUserTexts = (msgs: { role: string; content: { type: string; text?: string }[] }[]) =>
  msgs.filter((m) => m.role === 'user').flatMap((m) => m.content.filter((b) => b.type === 'text').map((b) => b.text));

describe('AgentRuntime pause', () => {
  it('waits at a step boundary without sending requests, then resumes the same turn', async () => {
    const { rt, provider, log } = await setup([textScript('done')]);
    rt.setPaused(true);
    const run = collect(rt.run('start'));
    await new Promise((r) => setTimeout(r, 20));
    expect(provider.requests).toHaveLength(0);
    expect(rt.busy).toBe(true);
    rt.setPaused(false);
    expect((await run).at(-1)).toMatchObject({ type: 'turn-end', reason: 'completed' });
    expect(provider.requests).toHaveLength(1);
    expect(replayMismatches(log.path)).toEqual([]);
    await log.close();
  });
  it('a paused run can be cancelled and does not leave the next turn paused', async () => {
    const { rt, provider, log } = await setup([textScript('next')]);
    rt.setPaused(true);
    const abort = new AbortController();
    const run = collect(rt.run('start', abort.signal));
    await new Promise((r) => setTimeout(r, 20));
    abort.abort();
    expect((await run).at(-1)).toMatchObject({ type: 'turn-end', reason: 'aborted' });
    expect(provider.requests).toHaveLength(0);
    expect(rt.paused).toBe(false);
    await collect(rt.run('next'));
    expect(provider.requests).toHaveLength(1);
    await log.close();
  });
});

describe('AgentRuntime：插话', () => {
  it('工具执行中排队的插话在下一个 step 送达模型', async () => {
    const gate = gateTool();
    const tools = new ToolRegistry();
    tools.register(gate.tool);
    const { rt, provider, log } = await setup([toolCallScript('c1', 'gate', {}), textScript('好的')], {}, tools);

    const run = collect(rt.run('开始'));
    await gate.startedP;
    expect(rt.busy).toBe(true);
    expect(rt.enqueue('顺便看下 README')).toBe(true);
    gate.release();
    const events = await run;

    expect(events.map((e) => e.type)).toContain('user-injected');
    expect(lastUserTexts(provider.requests[1]!.messages as never)).toContain('顺便看下 README');
    expect(replayMismatches(log.path)).toEqual([]);
  });

  it('模型无工具调用时仍有排队插话：继续请求而不是结束', async () => {
    const { rt, provider } = await setup([textScript('第一段'), textScript('回应插话')]);
    const gen = rt.run('hi');
    const first = await gen.next(); // turn-start
    expect(first.value).toMatchObject({ type: 'turn-start' });
    rt.enqueue('还有一件事');
    const rest = await collect(gen);
    expect(rest.filter((e) => e.type === 'turn-end')).toHaveLength(1);
    expect(provider.requests).toHaveLength(2);
  });

  it('中断时未送达的插话以 queue-restored 交还', async () => {
    const gate = gateTool();
    const tools = new ToolRegistry();
    tools.register(gate.tool);
    const { rt } = await setup([toolCallScript('c1', 'gate', {})], {}, tools);
    const controller = new AbortController();
    const run = collect(rt.run('开始', controller.signal));
    await gate.startedP;
    rt.enqueue('A');
    rt.enqueue('B');
    controller.abort();
    gate.release();
    const events = await run;
    expect(events.find((e) => e.type === 'queue-restored')).toEqual({ type: 'queue-restored', texts: ['A', 'B'] });
    expect(rt.busy).toBe(false);
  });

  it('空闲时 enqueue 返回 false（调用方需自行 run）', async () => {
    const { rt } = await setup([textScript('x')]);
    expect(rt.enqueue('x')).toBe(false);
  });
});

describe('AgentRuntime：边界钩子', () => {
  it('预算附件只注入一次，工具配对和重放保持一致', async () => {
    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: 'noop',
        description: 'noop',
        parameters: z.object({}),
        isReadOnly: true,
        isConcurrencySafe: true,
        execute: async () => textResult('ok'),
      }),
    );
    const { rt, log } = await setup(
      Array.from({ length: 7 }, (_, i) => toolCallScript(`b${i}`, 'noop', {})),
      { maxSteps: 7, budgetReminder: 'agent' },
      tools,
    );
    const events = await collect(rt.run('work'));
    expect(events.at(-1)).toMatchObject({ reason: 'max-steps' });
    const recorded = loadRunLog(log.path).events;
    expect(
      recorded
        .filter((e) => e.type === 'attachment/injected' && e.source === 'budget')
        .map((e) => (e.type === 'attachment/injected' ? e.step : 0)),
    ).toEqual([6, 7]);
    expect(replayMismatches(log.path)).toEqual([]);
    expect(recorded.filter((e) => e.type === 'tool/call')).toHaveLength(7);
    expect(recorded.filter((e) => e.type === 'tool/result')).toHaveLength(7);
    expect(events.some((e) => JSON.stringify(e).includes('[步数提醒]'))).toBe(false);
    await log.close();
  });
  it('beforeRequest 注入的附件落日志并进入请求，位于末尾 user 消息', async () => {
    const { rt, provider, log } = await setup([textScript('ok')], {
      boundary: { beforeRequest: () => [{ kind: 'inject', source: 'todo', blocks: [{ type: 'text', text: '<todo>1</todo>' }] }] },
    });
    await collect(rt.run('hi'));
    const last = provider.requests[0]!.messages.at(-1)!;
    expect(last.content).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'text', text: '<todo>1</todo>' },
    ]);
    const types = loadRunLog(log.path).events.map((e) => e.type);
    expect(types).toContain('attachment/injected');
    expect(replayMismatches(log.path)).toEqual([]);
  });

  it('onWouldEndTurn 返回 wait：等待期间不发请求，等到后 continue', async () => {
    let resolveWait: () => void = () => {};
    let calls = 0;
    const { rt, provider } = await setup([textScript('先等子任务'), textScript('收到结果')], {
      boundary: {
        beforeRequest: () => (calls === 2 ? [{ kind: 'inject', source: 'inbox', blocks: [{ type: 'text', text: '子任务完成' }] }] : []),
        onWouldEndTurn: () => {
          calls++;
          if (calls === 1) return { kind: 'wait', reason: '等待子 agent', until: new Promise<void>((r) => (resolveWait = r)) };
          if (calls === 2) return { kind: 'continue' };
          return { kind: 'end' };
        },
      },
    });
    const gen = collect(rt.run('派发'));
    await new Promise((r) => setTimeout(r, 20));
    expect(provider.requests).toHaveLength(1); // 等待中未发第二次请求
    resolveWait();
    const events = await gen;
    expect(events.map((e) => e.type)).toContain('waiting');
    expect(provider.requests).toHaveLength(2);
    expect(lastUserTexts(provider.requests[1]!.messages as never)).toContain('子任务完成');
  });
});

describe('AgentRuntime：重试', () => {
  it('429 + retry-after：按服务端建议等待后重试成功，落 step/retry', async () => {
    const clock = new FakeClock();
    const rateLimited = [
      {
        type: 'finish' as const,
        reason: 'error' as const,
        error: new RoastError('RATE_LIMIT', '429', { retryable: true, retryAfterMs: 3000 }),
      },
    ];
    const { rt, log } = await setup([rateLimited, textScript('ok')], { clock });
    const events = await collect(rt.run('hi'));
    expect(clock.sleeps).toEqual([3000]);
    expect(events.find((e) => e.type === 'retry')).toMatchObject({ attempt: 1, delayMs: 3000, code: 'RATE_LIMIT' });
    expect(events.at(-1)).toMatchObject({ type: 'turn-end', reason: 'completed' });
    expect(loadRunLog(log.path).events.map((e) => e.type)).toContain('step/retry');
    expect(replayMismatches(log.path)).toEqual([]);
  });

  it('已流出部分内容后失败：先 stream-reset 再重试', async () => {
    const partialThenFail: Script = [
      { type: 'block-start', index: 0, block: 'text' },
      { type: 'text-delta', index: 0, text: '半截' },
      { type: 'finish', reason: 'error', error: new RoastError('SERVER', '502', { retryable: true }) },
    ];
    const { rt } = await setup([partialThenFail, textScript('完整')]);
    const types = (await collect(rt.run('hi'))).map((e) => e.type);
    expect(types.indexOf('stream-reset')).toBeGreaterThan(types.indexOf('text-delta'));
    expect(types.indexOf('retry')).toBeGreaterThan(types.indexOf('stream-reset'));
  });

  it('不可重试错误直接结束 turn', async () => {
    const { rt, provider } = await setup([errorScript('AUTH', 'bad key')]);
    const events = await collect(rt.run('hi'));
    expect(provider.requests).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'turn-end', reason: 'error' });
  });

  it('重试次数用尽后以 error 结束', async () => {
    const fail = errorScript('SERVER', '500', true);
    const { rt, provider } = await setup([fail, fail, fail], {
      retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1, jitter: 0, maxRetryAfterMs: 1 },
    });
    const events = await collect(rt.run('hi'));
    expect(provider.requests).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ type: 'turn-end', reason: 'error' });
  });
});

describe('AgentRuntime：M1 评审修复', () => {
  it('插话同样经过 inputGuard：被拦截的插话不送达模型', async () => {
    const gate = gateTool();
    const tools = new ToolRegistry();
    tools.register(gate.tool);
    const { rt, provider } = await setup(
      [toolCallScript('c1', 'gate', {}), textScript('ok')],
      {
        extensions: {
          inputGuard: { check: async (t) => (t.includes('EVIL') ? { action: 'block', reason: 'bad' } : { action: 'pass' }) },
        },
      },
      tools,
    );
    const run = collect(rt.run('开始'));
    await gate.startedP;
    rt.enqueue('EVIL 指令');
    gate.release();
    const events = await run;
    expect(JSON.stringify(provider.requests[1]!.messages)).not.toContain('EVIL');
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'turn-end', reason: 'completed' });
  });

  it('空闲时 enqueue 不入队，随后 run 不会重复发送', async () => {
    const { rt, provider } = await setup([textScript('x')]);
    expect(rt.enqueue('同一句')).toBe(false);
    await collect(rt.run('同一句'));
    expect(provider.requests).toHaveLength(1);
    expect(JSON.stringify(provider.requests[0]!.messages).split('同一句').length - 1).toBe(1);
  });

  it('最后一步收到插话：本 turn 正常结束，插话作为新 turn 处理', async () => {
    const { rt, provider } = await setup([textScript('第一轮'), textScript('第二轮')], { maxSteps: 1 });
    const gen = rt.run('a');
    await gen.next(); // turn-start
    rt.enqueue('b');
    const events = await collect(gen);
    const ends = events.filter((e) => e.type === 'turn-end');
    expect(ends.map((e) => (e as { reason: string }).reason)).toEqual(['completed', 'completed']);
    expect(provider.requests).toHaveLength(2);
  });

  it('onWouldEndTurn 返回 continue 但没有新内容：不发以 assistant 结尾的请求', async () => {
    const { rt, provider } = await setup([textScript('答完了'), textScript('不应被请求')], {
      boundary: { onWouldEndTurn: () => ({ kind: 'continue' }) },
    });
    const events = await collect(rt.run('q'));
    expect(provider.requests).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'turn-end', reason: 'completed' });
  });

  it('whenIdle：drive 结束后 resolve', async () => {
    const { rt } = await setup([textScript('x')]);
    const run = collect(rt.run('q'));
    const idle = rt.whenIdle();
    await run;
    await expect(idle).resolves.toBeUndefined();
  });
});
