/**
 * bash 工具：运行 shell 命令（解析见 shell.ts，进程生命周期见 run.ts，输出解码见 output.ts）。
 */
import { z } from 'zod';
import { defineTool, textResult, toolErrorResult, type ToolResult } from '../tool.js';
import { truncateOutput } from './output.js';
import { getJobRegistry } from './jobs.js';
import { runForeground } from './run.js';

export { truncateOutput } from './output.js';

const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const parameters = z.object({
  command: z
    .string()
    .describe(
      '要执行的 shell 命令。本工具在 Windows 上优先使用 Git Bash（C:\\Program Files\\Git\\bin\\bash.exe -c），' +
        '不存在时回退 cmd.exe /c；POSIX 系统使用 /bin/bash -c。因此应尽量使用 bash 语法（/dev/null、正斜杠路径）。',
    ),
  timeout: z
    .number()
    .int()
    .min(1)
    .max(MAX_TIMEOUT_MS)
    .default(DEFAULT_TIMEOUT_MS)
    .describe(`超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}，最大 ${MAX_TIMEOUT_MS}`),
  run_in_background: z
    .boolean()
    .default(false)
    .describe('为 true 时在后台运行并立即返回 job_id（适合 dev server、watch 等长期进程），之后用 bash_output 读取输出'),
});

function abortError(): DOMException {
  return new DOMException('命令被中断', 'AbortError');
}

export const bashTool = defineTool({
  name: 'bash',
  description:
    '执行 shell 命令并返回合并的 stdout+stderr 与 exit code。' +
    '平台事实：Windows 下优先走 Git Bash（bash -c），无 Git Bash 时回退 cmd.exe /c；POSIX 走 /bin/bash -c。' +
    '约束：默认超时 120s（最大 600s）；输出超过 30000 字符会截断（保留头尾）；' +
    '命令结束后若有子进程留在后台，工具会在短暂宽限后返回；' +
    'run_in_background=true 时后台运行并返回 job_id，用 bash_output 读输出、kill_shell 终止。',
  parameters,
  isReadOnly: false,
  isConcurrencySafe: false,
  permission: { kind: 'execute', target: (args) => args.command },
  // 兜底超时：略大于参数最大值，保证工具自身的 timeout 参数先生效
  timeoutMs: MAX_TIMEOUT_MS + 30_000,

  async execute(args, ctx): Promise<ToolResult> {
    if (ctx.signal.aborted) throw abortError();
    if (args.run_in_background) {
      const info = getJobRegistry(ctx.services).start(args.command, ctx.cwd);
      return textResult(
        `命令已在后台启动：job_id=${info.id}，pid=${info.pid ?? 'unknown'}。用 bash_output 查看输出与状态，用 kill_shell 终止。`,
        { jobId: info.id, pid: info.pid },
      );
    }

    const outcome = await runForeground({
      command: args.command,
      cwd: ctx.cwd,
      timeoutMs: args.timeout,
      signal: ctx.signal,
      ...(ctx.progress ? { onOutput: (text: string, stream: 'out' | 'err') => ctx.progress?.({ text, stream }) } : {}),
    });
    switch (outcome.kind) {
      case 'aborted':
        // 调用方 abort 向外抛（由 executor 归一化为 ABORTED）
        throw abortError();
      case 'spawn-error':
        return toolErrorResult('bash', `无法启动命令: ${outcome.message}`);
      case 'timeout': {
        const partial = outcome.output.trim() ? `\n已产生的部分输出:\n${truncateOutput(outcome.output)}` : '';
        return toolErrorResult('bash', `命令超时（${args.timeout}ms），进程已终止。${partial}`);
      }
      case 'exited': {
        const body = truncateOutput(outcome.output);
        const exitLine =
          outcome.code !== null ? `Exit code: ${outcome.code}` : `Terminated by signal: ${outcome.signal ?? 'unknown'}`;
        return textResult(`${body}${body.endsWith('\n') || body === '' ? '' : '\n'}${exitLine}`, {
          exitCode: outcome.code ?? undefined,
          signal: outcome.signal ?? undefined,
        });
      }
    }
  },
});
