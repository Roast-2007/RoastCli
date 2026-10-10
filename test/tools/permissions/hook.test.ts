import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { InteractionBroker } from '../../../src/core/interaction.js';
import { executeTool } from '../../../src/tools/executor.js';
import { PermissionEngine, type PermissionMode } from '../../../src/tools/permissions/engine.js';
import { EXECUTION_ROOT_KEY, READ_ONLY_ROLE_KEY, permissionHook } from '../../../src/tools/permissions/hook.js';
import { defineTool, textResult } from '../../../src/tools/tool.js';
import { makeCtx, textOf } from '../helpers.js';

const runTool = defineTool({
  name: 'bash',
  description: 'fake bash',
  parameters: z.object({ command: z.string() }),
  isReadOnly: false,
  isConcurrencySafe: false,
  permission: { kind: 'execute', target: (args) => args.command },
  execute: async (args) => textResult(`ran ${args.command}`),
});

function setup(mode: PermissionMode = 'default') {
  const engine = new PermissionEngine({ allow: [], ask: [], deny: ['bash(npm publish:*)'], mode });
  const broker = new InteractionBroker();
  const grants: string[] = [];
  const denials: string[] = [];
  const hooks = {
    preExecute: [permissionHook({ engine, broker, onGrant: (rule) => grants.push(rule), onDeny: (key) => denials.push(key) })],
    postExecute: [],
  };
  return { engine, broker, hooks, grants, denials };
}

describe('permissionHook', () => {
  it('asks about unfamiliar read-only-role commands even in yolo and never remembers that exception', async () => {
    const { engine, hooks, broker, grants } = setup('yolo');
    engine.grant('bash', 'session');
    const ctx = makeCtx('/project');
    ctx.services.set(READ_ONLY_ROLE_KEY, 'scout');
    const requests: string[] = [];
    broker.onRequest((request) => {
      if (request.kind !== 'permission') throw new Error('Expected permission');
      expect(request.forced).toBe(true);
      expect(request.reason).toContain('只读角色 scout');
      requests.push(request.tool);
      broker.respond(request.id, { kind: 'permission', decision: requests.length === 1 ? 'allow' : 'deny', remember: 'session' });
    });
    expect(textOf(await executeTool(runTool, { command: 'node -e "console.log(1)"' }, ctx, hooks))).toContain('ran node');
    expect((await executeTool(runTool, { command: 'node -e "console.log(1)"' }, ctx, hooks)).isError).toBe(true);
    expect(requests).toHaveLength(2);
    expect(grants).toEqual([]);
    expect((await executeTool(runTool, { command: 'npm publish' }, ctx, hooks)).isError).toBe(true);
    expect(requests).toHaveLength(2);
  });
  it('worktree 执行遵循 yolo，不额外询问', async () => {
    const { engine, hooks, broker, grants } = setup('yolo');
    engine.grant('bash', 'session');
    const ctx = makeCtx('/worktree');
    ctx.services.set(EXECUTION_ROOT_KEY, ctx.cwd);
    const requests: boolean[] = [];
    broker.onRequest((req) => {
      if (req.kind === 'permission') {
        requests.push(req.forced === true);
        broker.respond(req.id, { kind: 'permission', decision: requests.length === 1 ? 'allow' : 'deny', remember: 'session' });
      }
    });
    expect(textOf(await executeTool(runTool, { command: 'pnpm test' }, ctx, hooks))).toBe('ran pnpm test');
    expect((await executeTool(runTool, { command: 'pnpm test' }, ctx, hooks)).isError).toBeUndefined();
    expect(requests).toEqual([]);
    expect(grants).toEqual([]);
  });

  it('复合命令逐条授权，同一命令再次执行不询问', async () => {
    const { hooks, broker, grants } = setup();
    let asks = 0;
    broker.onRequest((req) => {
      asks++;
      if (req.kind === 'permission') expect(req.suggestedRules).toEqual(['bash(npm test:*)', 'bash(sed:*)']);
      broker.respond(req.id, { kind: 'permission', decision: 'allow', remember: 'project' });
    });
    const ctx = makeCtx('/worktree');
    ctx.services.set(EXECUTION_ROOT_KEY, ctx.cwd);
    const args = { command: 'cd "a b" && npm test && sed -n 1p a' };
    await executeTool(runTool, args, ctx, hooks);
    await executeTool(runTool, args, ctx, hooks);
    expect(asks).toBe(1);
    expect(grants).toEqual(['bash(npm test:*)', 'bash(sed:*)']);
  });

  it('allow：直接执行', async () => {
    const { hooks } = setup();
    const r = await executeTool(runTool, { command: 'git status' }, makeCtx('/p'), hooks);
    expect(textOf(r)).toBe('ran git status');
  });

  it('deny：返回模型可读的拒绝原因', async () => {
    const { hooks } = setup();
    const r = await executeTool(runTool, { command: 'npm publish' }, makeCtx('/p'), hooks);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('deny');
  });

  it('ask → 用户允许并记住：执行且登记授权', async () => {
    const { hooks, broker, engine, grants } = setup();
    broker.onRequest((req) => broker.respond(req.id, { kind: 'permission', decision: 'allow', remember: 'session' }));
    const r = await executeTool(runTool, { command: 'npm install' }, makeCtx('/p'), hooks);
    expect(textOf(r)).toBe('ran npm install');
    expect(grants).toEqual(['bash(npm install:*)']);
    expect(engine.evaluate({ tool: 'bash', kind: 'execute', target: 'npm install lodash', cwd: '/p' }).behavior).toBe('allow');
  });

  it('ask → 用户拒绝并说明：反馈给模型', async () => {
    const { hooks, broker } = setup();
    broker.onRequest((req) => broker.respond(req.id, { kind: 'permission', decision: 'deny', feedback: '先跑测试' }));
    const r = await executeTool(runTool, { command: 'npm install' }, makeCtx('/p'), hooks);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('先跑测试');
  });

  it('无交互界面（管道模式）：ask 视为拒绝并提示如何授权', async () => {
    const { hooks } = setup();
    const r = await executeTool(runTool, { command: 'npm install' }, makeCtx('/p'), hooks);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('非交互');
  });

  it('等待授权期间 abort：调用以中断结束', async () => {
    const { hooks, broker } = setup();
    broker.onRequest(() => {}); // 有界面但用户迟迟不回答
    const ctx = makeCtx('/p');
    setTimeout(() => ctx.controller.abort(), 20);
    await expect(executeTool(runTool, { command: 'npm install' }, ctx, hooks)).rejects.toMatchObject({ code: 'ABORTED' });
    expect(broker.pending()).toEqual([]);
  });
});

describe('permissionHook：帮我审批', () => {
  it('高风险操作带 10 秒倒计时；超时拒绝不记住，再次调用会重新询问', async () => {
    const { hooks, broker, denials } = setup('auto');
    const asked: (number | undefined)[] = [];
    broker.onRequest((req) => {
      if (req.kind !== 'permission') throw new Error('Expected permission');
      asked.push(req.countdownMs);
      broker.respond(
        req.id,
        asked.length === 1 ? { kind: 'permission', decision: 'deny', timedOut: true } : { kind: 'permission', decision: 'allow' },
      );
    });
    const ctx = makeCtx('/project');
    const timedOut = await executeTool(runTool, { command: 'git push origin main' }, ctx, hooks);
    expect(timedOut.isError).toBe(true);
    expect(textOf(timedOut)).toContain('10 秒内没有响应');
    expect(textOf(timedOut)).toContain('再次发起同样的调用');
    expect(textOf(await executeTool(runTool, { command: 'git push origin main' }, ctx, hooks))).toContain('ran git push');
    expect(asked).toEqual([10_000, 10_000]);
    expect(denials).toEqual([]);
    expect(textOf(await executeTool(runTool, { command: 'pnpm test' }, ctx, hooks))).toContain('ran pnpm test');
    expect(asked).toHaveLength(2);
  });

  it('用户明确拒绝后记住并回调，完全相同的操作不再询问而直接拒绝', async () => {
    const { hooks, broker, denials } = setup('auto');
    let asked = 0;
    broker.onRequest((req) => {
      asked++;
      broker.respond(req.id, { kind: 'permission', decision: 'deny' });
    });
    const ctx = makeCtx('/project');
    const denied = await executeTool(runTool, { command: 'git push origin main' }, ctx, hooks);
    expect(textOf(denied)).toContain('本会话会自动拒绝完全相同的操作');
    expect(denials).toHaveLength(1);
    const again = await executeTool(runTool, { command: 'git push  origin main' }, ctx, hooks);
    expect(again.isError).toBe(true);
    expect(textOf(again)).toContain('已拒绝过完全相同的操作');
    expect(asked).toBe(1);
    await executeTool(runTool, { command: 'git push origin dev' }, ctx, hooks);
    expect(asked).toBe(2);
  });

  it('其他模式的拒绝不记住，也不带倒计时', async () => {
    const { hooks, broker, denials } = setup('default');
    const countdowns: (number | undefined)[] = [];
    broker.onRequest((req) => {
      if (req.kind === 'permission') countdowns.push(req.countdownMs);
      broker.respond(req.id, { kind: 'permission', decision: 'deny' });
    });
    await executeTool(runTool, { command: 'git push origin main' }, makeCtx('/project'), hooks);
    expect(countdowns).toEqual([undefined]);
    expect(denials).toEqual([]);
  });
});

describe('InteractionBroker：帮我审批倒计时', () => {
  afterEach(() => vi.useRealTimers());
  const ask = (broker: InteractionBroker, signal = new AbortController().signal) =>
    broker.request(
      { kind: 'permission', agentId: 'main', tool: 'bash', title: 'bash: git push', reason: 'r', countdownMs: 10_000 },
      signal,
    );

  it('显示后才开始计时，到时以 timedOut 拒绝；重复显示不重置', async () => {
    vi.useFakeTimers();
    const broker = new InteractionBroker();
    broker.onRequest(() => {});
    const result = ask(broker);
    const id = broker.pending()[0]!.id;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(broker.pending()).toHaveLength(1);
    broker.shown(id);
    const deadline = broker.pending()[0]!.deadline;
    expect(deadline).toBeTypeOf('number');
    await vi.advanceTimersByTimeAsync(6_000);
    broker.shown(id);
    expect(broker.pending()[0]!.deadline).toBe(deadline);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await result).toEqual({ kind: 'permission', decision: 'deny', timedOut: true });
    expect(broker.pending()).toEqual([]);
  });

  it('用户操作后暂停倒计时并等待明确作答；中断时清理计时器', async () => {
    vi.useFakeTimers();
    const broker = new InteractionBroker();
    broker.onRequest(() => {});
    const held = ask(broker);
    const id = broker.pending()[0]!.id;
    broker.shown(id);
    broker.hold(id);
    expect(broker.pending()[0]!.paused).toBe(true);
    broker.shown(id);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(broker.pending()).toHaveLength(1);
    broker.respond(id, { kind: 'permission', decision: 'allow' });
    expect(await held).toEqual({ kind: 'permission', decision: 'allow' });

    const controller = new AbortController();
    const aborted = ask(broker, controller.signal);
    broker.shown(broker.pending()[0]!.id);
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: 'ABORTED' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('没有倒计时的请求忽略 shown / hold', () => {
    const broker = new InteractionBroker();
    broker.onRequest(() => {});
    void broker.request({ kind: 'question', agentId: 'main', question: 'q' }, new AbortController().signal);
    const id = broker.pending()[0]!.id;
    broker.shown(id);
    broker.hold(id);
    expect(broker.pending()[0]).not.toHaveProperty('deadline');
    expect(broker.pending()[0]).not.toHaveProperty('paused');
  });
});

describe('InteractionBroker', () => {
  it('notifies on cancellation without turning a headless run into an interactive one', async () => {
    const broker = new InteractionBroker();
    const snapshots: number[] = [];
    broker.onChange(() => snapshots.push(broker.pending().length));
    const controller = new AbortController();
    expect(await broker.request({ kind: 'question', agentId: 's1', question: 'headless' }, controller.signal)).toEqual({
      kind: 'unavailable',
    });
    expect(broker.interactive).toBe(false);
    broker.onRequest(() => {});
    const request = broker.request({ kind: 'question', agentId: 's1', question: 'interactive' }, controller.signal);
    controller.abort();
    await expect(request).rejects.toMatchObject({ code: 'ABORTED' });
    expect(snapshots).toEqual([1, 0]);
  });
  it('pending 列表与 respond', async () => {
    const broker = new InteractionBroker();
    const seen: string[] = [];
    broker.onRequest((r) => seen.push(r.kind));
    const p = broker.request(
      { kind: 'question', agentId: 'main', question: '用哪个方案？', options: ['A', 'B'] },
      new AbortController().signal,
    );
    expect(broker.pending()).toHaveLength(1);
    broker.respond(broker.pending()[0]!.id, { kind: 'question', answer: 'B' });
    expect(await p).toEqual({ kind: 'question', answer: 'B' });
    expect(seen).toEqual(['question']);
    expect(broker.pending()).toEqual([]);
  });
});
