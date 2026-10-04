import { describe, expect, it } from 'vitest';
import { bashTool } from '../../src/tools/bash/index.js';
import { bashOutputTool, killShellTool } from '../../src/tools/bash/job-tools.js';
import { executeTool } from '../../src/tools/executor.js';
import { makeCtx, makeTmpDir, textOf } from './helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 去掉首行状态行（其中含命令原文），只看输出正文 */
const bodyOf = (text: string) => text.split('\n').slice(1).join('\n');

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error('等待超时');
}

describe('后台任务', () => {
  it('bash_output 增量读取新输出，结束后报告 exit code', async () => {
    const ctx = makeCtx(await makeTmpDir());
    const started = await executeTool(bashTool, { command: 'echo first; sleep 1; echo second', run_in_background: true }, ctx);
    const jobId = /job_id=(job-\d+)/.exec(textOf(started))![1]!;

    await waitFor(async () => textOf(await executeTool(bashOutputTool, { job_id: jobId }, ctx)).includes('first'));
    let final = '';
    await waitFor(async () => {
      final = textOf(await executeTool(bashOutputTool, { job_id: jobId }, ctx));
      return final.includes('exited');
    });
    expect(final).toContain('exit code 0');
    // second 可能在最后一次读或之前读到，但 first 不会被重复返回
    expect(bodyOf(final)).not.toContain('first');
  }, 15_000);

  it('filter 只保留匹配的行', async () => {
    const ctx = makeCtx(await makeTmpDir());
    const started = await executeTool(bashTool, { command: 'echo keep-1; echo drop; echo keep-2', run_in_background: true }, ctx);
    const jobId = /job_id=(job-\d+)/.exec(textOf(started))![1]!;
    await sleep(800);
    const text = textOf(await executeTool(bashOutputTool, { job_id: jobId, filter: '^keep' }, ctx));
    expect(text).toContain('keep-1');
    expect(text).toContain('keep-2');
    expect(bodyOf(text)).not.toContain('drop');
  }, 10_000);

  it('kill_shell 终止运行中的任务', async () => {
    const ctx = makeCtx(await makeTmpDir());
    const started = await executeTool(bashTool, { command: 'sleep 30', run_in_background: true }, ctx);
    const jobId = /job_id=(job-\d+)/.exec(textOf(started))![1]!;
    const killed = await executeTool(killShellTool, { job_id: jobId }, ctx);
    expect(textOf(killed)).toContain('killed');
    const status = textOf(await executeTool(bashOutputTool, { job_id: jobId }, ctx));
    expect(status).toContain('killed');
  });

  it('未知任务 id 返回错误', async () => {
    const ctx = makeCtx(await makeTmpDir());
    expect((await executeTool(bashOutputTool, { job_id: 'job-99' }, ctx)).isError).toBe(true);
  });
});
