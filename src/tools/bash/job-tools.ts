/**
 * bash_output / kill_shell：读取与终止 bash run_in_background 启动的后台任务。
 */
import { z } from 'zod';
import { defineTool, textResult, toolErrorResult, type ToolResult } from '../tool.js';
import { getJobRegistry, type JobInfo } from './jobs.js';
import { truncateOutput } from './output.js';

function statusLine(info: JobInfo): string {
  const age = Math.round((Date.now() - info.startedAt) / 1000);
  const code = info.status === 'exited' ? `，exit code ${info.exitCode}` : '';
  return `[${info.id}] ${info.status}${code}（已运行 ${age}s，pid=${info.pid ?? '?'}）: ${info.command}`;
}

export const bashOutputTool = defineTool({
  name: 'bash_output',
  description: '读取后台任务（bash run_in_background 启动）自上次读取以来的新输出与当前状态。可用 filter 正则只保留匹配的行。',
  parameters: z.object({
    job_id: z.string().describe('后台任务 id，如 job-1'),
    filter: z.string().optional().describe('只返回匹配该正则的输出行'),
  }),
  isReadOnly: true,
  isConcurrencySafe: true,
  permission: { kind: 'read' },

  async execute(args, ctx): Promise<ToolResult> {
    let filter: RegExp | undefined;
    try {
      filter = args.filter ? new RegExp(args.filter) : undefined;
    } catch (err) {
      return toolErrorResult('bash_output', `filter 不是合法正则: ${err instanceof Error ? err.message : String(err)}`);
    }
    const r = getJobRegistry(ctx.services).read(args.job_id, filter);
    if (!r) return toolErrorResult('bash_output', `没有后台任务 ${args.job_id}`);
    const dropped = r.dropped ? '\n[部分较早的输出因缓冲上限已丢弃]' : '';
    const body = r.output ? truncateOutput(r.output) : '（无新输出）';
    return textResult(`${statusLine(r.info)}${dropped}\n${body}`, { status: r.info.status, exitCode: r.info.exitCode });
  },
});

export const killShellTool = defineTool({
  name: 'kill_shell',
  description: '终止一个后台任务（连同其子进程）。',
  parameters: z.object({ job_id: z.string().describe('后台任务 id，如 job-1') }),
  isReadOnly: false,
  isConcurrencySafe: false,
  permission: { kind: 'interact' },

  async execute(args, ctx): Promise<ToolResult> {
    const info = getJobRegistry(ctx.services).kill(args.job_id);
    if (!info) return toolErrorResult('kill_shell', `没有后台任务 ${args.job_id}`);
    return textResult(statusLine(info), { status: info.status });
  },
});
