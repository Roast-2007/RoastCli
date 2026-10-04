import { describe, expect, it } from 'vitest';
import { bashTool } from '../../src/tools/bash/index.js';
import { executeTool } from '../../src/tools/executor.js';
import { makeCtx, makeTmpDir, textOf } from './helpers.js';

describe('bash 工具', () => {
  it('echo hello：输出与 exit code', async () => {
    const ctx = makeCtx(await makeTmpDir());
    const result = await executeTool(bashTool, { command: 'echo hello' }, ctx);
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain('hello');
    expect(text).toContain('Exit code: 0');
  });

  it('非零 exit code 体现在输出中', async () => {
    const ctx = makeCtx(await makeTmpDir());
    const result = await executeTool(bashTool, { command: 'exit 3' }, ctx);
    expect(textOf(result)).toContain('Exit code: 3');
  });

  it('超时：进程被杀，返回 isError', async () => {
    const ctx = makeCtx(await makeTmpDir());
    const cmd = process.platform === 'win32' ? 'sleep 30' : 'sleep 30';
    const result = await executeTool(bashTool, { command: cmd, timeout: 500 }, ctx);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('超时');
  }, 20_000);

  it('run_in_background：立即返回 pid', async () => {
    const ctx = makeCtx(await makeTmpDir());
    const result = await executeTool(bashTool, { command: 'echo bg', run_in_background: true }, ctx);
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain('pid=');
    expect(text).toContain('job_id=job-1');
  });
});

describe('bash 工具：输出解码', () => {
  it('多字节 UTF-8 字符跨 chunk 时不乱码', async () => {
    const ctx = makeCtx(await makeTmpDir());
    const command = String.raw`printf '\xe4\xb8'; sleep 0.3; printf '\xad\xe6\x96\x87\n'`;
    const result = await executeTool(bashTool, { command }, ctx);
    const text = textOf(result);
    expect(text).toContain('中文');
    expect(text).not.toContain('�');
  });

  it.runIf(process.platform === 'win32')('非 UTF-8 输出（GBK）回退解码', async () => {
    const ctx = makeCtx(await makeTmpDir());
    const command = String.raw`printf '\xd6\xd0\xce\xc4\n'`;
    const result = await executeTool(bashTool, { command }, ctx);
    expect(textOf(result)).toContain('中文');
  });

  it('stderr 与 stdout 交错时多字节字符不被拆坏', async () => {
    const ctx = makeCtx(await makeTmpDir());
    const command = String.raw`printf '\xe4\xb8'; printf 'E' >&2; sleep 0.2; printf '\xad\n'`;
    const result = await executeTool(bashTool, { command }, ctx);
    const text = textOf(result);
    expect(text).toContain('中');
    expect(text).not.toContain('�');
  });

  it('单个非法字节不会让整段 UTF-8 输出被误判为 GBK', async () => {
    const ctx = makeCtx(await makeTmpDir());
    const command = String.raw`printf '编译中文输出完成\xff\n'`;
    const result = await executeTool(bashTool, { command }, ctx);
    expect(textOf(result)).toContain('编译中文输出完成');
  });

  it('子进程环境强制 UTF-8', async () => {
    const ctx = makeCtx(await makeTmpDir());
    const result = await executeTool(bashTool, { command: 'echo "enc=$PYTHONIOENCODING"' }, ctx);
    expect(textOf(result)).toContain('enc=utf-8');
  });
});

describe('bash 工具：实时进度', () => {
  it('输出通过 ctx.progress 实时上报（UTF-8 跨 chunk 不乱码）', async () => {
    const ctx = makeCtx(await makeTmpDir());
    const seen: string[] = [];
    const command = String.raw`printf '\xe4\xb8'; sleep 0.2; printf '\xad\n'; echo second`;
    await executeTool(bashTool, { command }, { ...ctx, progress: (p) => seen.push(p.text) });
    const joined = seen.join('');
    expect(joined).toContain('中');
    expect(joined).toContain('second');
    expect(joined).not.toContain('�');
  });
});

describe('bash 工具：进程生命周期', () => {
  it('signal 已中断：不执行命令，立即以中断结束', async () => {
    const ctx = makeCtx(await makeTmpDir());
    ctx.controller.abort();
    const started = Date.now();
    await expect(executeTool(bashTool, { command: 'sleep 3; echo done' }, ctx)).rejects.toMatchObject({ code: 'ABORTED' });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('命令把子进程放到后台（占住管道）：前台结束后很快返回', async () => {
    const ctx = makeCtx(await makeTmpDir());
    const started = Date.now();
    const result = await executeTool(bashTool, { command: 'sleep 4 & echo started' }, ctx);
    expect(textOf(result)).toContain('started');
    expect(Date.now() - started).toBeLessThan(3000);
  }, 10_000);

  it('后台孙进程占住管道时 abort 能在宽限期内结束', async () => {
    const ctx = makeCtx(await makeTmpDir());
    const started = Date.now();
    setTimeout(() => ctx.controller.abort(), 300);
    await expect(executeTool(bashTool, { command: 'sleep 5 & sleep 5' }, ctx)).rejects.toMatchObject({ code: 'ABORTED' });
    expect(Date.now() - started).toBeLessThan(3500);
  }, 10_000);
});
