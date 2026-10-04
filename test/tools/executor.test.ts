import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { executeTool } from '../../src/tools/executor.js';
import { defineTool, emptyHooks, textResult } from '../../src/tools/tool.js';
import { makeCtx, textOf } from './helpers.js';

const echoTool = defineTool({
  name: 'echo-test',
  description: 'test',
  parameters: z.object({ msg: z.string() }),
  isReadOnly: true,
  isConcurrencySafe: true,
  execute: async (args) => textResult(`echo:${args.msg}`),
});

const sleepTool = defineTool({
  name: 'sleep-test',
  description: 'test',
  parameters: z.object({ ms: z.number() }),
  isReadOnly: true,
  isConcurrencySafe: true,
  timeoutMs: 50,
  execute: async (args, ctx) => {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, args.ms);
      ctx.signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new DOMException('aborted', 'AbortError'));
      });
    });
    return textResult('slept');
  },
});

describe('executeTool', () => {
  it('正常执行并透传结果', async () => {
    const ctx = makeCtx('.');
    const result = await executeTool(echoTool, { msg: 'hi' }, ctx);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe('echo:hi');
  });

  it('zod 校验失败：返回模型可读的 isError（不抛），列出字段错误', async () => {
    const ctx = makeCtx('.');
    const result = await executeTool(echoTool, { msg: 123 }, ctx);
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('参数校验失败');
    expect(text).toContain('msg');
  });

  it('preExecute deny：返回带 reason 的 isError，不执行工具', async () => {
    const ctx = makeCtx('.');
    let executed = false;
    const spy = defineTool({
      ...echoTool,
      name: 'spy',
      execute: async (args) => {
        executed = true;
        return textResult(String(args.msg));
      },
    });
    const result = await executeTool(spy, { msg: 'x' }, ctx, {
      ...emptyHooks(),
      preExecute: [() => ({ action: 'deny' as const, reason: '审批拒绝' })],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('审批拒绝');
    expect(executed).toBe(false);
  });

  it('preExecute 可改写参数', async () => {
    const ctx = makeCtx('.');
    const result = await executeTool(echoTool, { msg: 'orig' }, ctx, {
      ...emptyHooks(),
      preExecute: [() => ({ action: 'allow' as const, args: { msg: 'rewritten' } })],
    });
    expect(textOf(result)).toBe('echo:rewritten');
  });

  it('超时：返回 isError 结果而非抛出', async () => {
    const ctx = makeCtx('.');
    const result = await executeTool(sleepTool, { ms: 5_000 }, ctx);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('超时');
  });

  it('调用方 abort 向外抛', async () => {
    const ctx = makeCtx('.');
    const p = executeTool(sleepTool, { ms: 5_000 }, ctx);
    ctx.controller.abort();
    await expect(p).rejects.toMatchObject({ name: 'RoastError', code: 'ABORTED' });
  });

  it('validateInput 返回字符串 → isError', async () => {
    const ctx = makeCtx('.');
    const guarded = defineTool({
      ...echoTool,
      name: 'guarded',
      validateInput: (args) => (args.msg === 'bad' ? 'msg 不能是 bad' : undefined),
    });
    const result = await executeTool(guarded, { msg: 'bad' }, ctx);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('msg 不能是 bad');
  });

  it('postExecute 可替换结果', async () => {
    const ctx = makeCtx('.');
    const result = await executeTool(echoTool, { msg: 'x' }, ctx, {
      ...emptyHooks(),
      postExecute: [() => textResult('replaced')],
    });
    expect(textOf(result)).toBe('replaced');
  });
});
