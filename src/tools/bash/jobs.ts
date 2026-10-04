/**
 * 后台任务注册表：bash run_in_background 启动的进程。
 * - 输出按流 UTF-8 流式解码，追加到环形文本缓冲（保留最近 MAX_BUFFER_CHARS 字符）
 * - 每个任务维护读游标：bash_output 只返回上次读取之后的新输出
 * - 进程退出时同步杀掉所有仍在运行的任务（exit 处理器不能跑异步代码）
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { utf8ChildEnv } from './output.js';
import { killTree, resolveShell } from './shell.js';
import type { ToolServices } from '../tool.js';

const MAX_BUFFER_CHARS = 1_000_000;

export type JobStatus = 'running' | 'exited' | 'killed' | 'failed';

export interface JobInfo {
  id: string;
  command: string;
  pid: number | undefined;
  startedAt: number;
  status: JobStatus;
  exitCode: number | null;
}

interface Job {
  info: JobInfo;
  child: ChildProcess;
  text: string;
  /** text[0] 在整个输出流中的绝对偏移（前面的已被丢弃） */
  base: number;
  cursor: number;
}

export interface JobRead {
  info: JobInfo;
  output: string;
  /** 自上次读取以来有输出因缓冲上限被丢弃 */
  dropped: boolean;
}

const registries = new Set<JobRegistry>();
let exitHookInstalled = false;

export class JobRegistry {
  private readonly jobs = new Map<string, Job>();
  private seq = 0;

  constructor() {
    registries.add(this);
    if (!exitHookInstalled) {
      exitHookInstalled = true;
      process.on('exit', () => {
        for (const r of registries) r.killAll();
      });
    }
  }

  start(command: string, cwd: string): JobInfo {
    const shell = resolveShell();
    const child = spawn(shell.file, [...shell.prefix, command], {
      cwd,
      env: utf8ChildEnv(),
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    const info: JobInfo = { id: `job-${++this.seq}`, command, pid: child.pid, startedAt: Date.now(), status: 'running', exitCode: null };
    const job: Job = { info, child, text: '', base: 0, cursor: 0 };
    this.jobs.set(info.id, job);
    const decoders = { out: new StringDecoder('utf8'), err: new StringDecoder('utf8') };
    const append = (s: string) => {
      job.text += s;
      if (job.text.length > MAX_BUFFER_CHARS) {
        const cut = job.text.length - MAX_BUFFER_CHARS;
        job.text = job.text.slice(cut);
        job.base += cut;
      }
    };
    child.stdout?.on('data', (d: Buffer) => append(decoders.out.write(d)));
    child.stderr?.on('data', (d: Buffer) => append(decoders.err.write(d)));
    child.on('error', (err) => {
      job.info = { ...job.info, status: 'failed' };
      append(`\n[启动失败: ${err.message}]\n`);
    });
    child.on('exit', (code) => {
      if (job.info.status === 'running') job.info = { ...job.info, status: 'exited', exitCode: code };
    });
    // 不让后台任务阻止 CLI 退出（退出时由 exit 处理器统一清理）
    child.unref();
    (child.stdout as unknown as { unref?: () => void } | null)?.unref?.();
    (child.stderr as unknown as { unref?: () => void } | null)?.unref?.();
    return info;
  }

  read(id: string, filter?: RegExp): JobRead | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    const dropped = job.cursor < job.base;
    const from = Math.max(job.cursor, job.base) - job.base;
    let output = job.text.slice(from);
    job.cursor = job.base + job.text.length;
    if (filter) output = output.split('\n').filter((l) => filter.test(l)).join('\n');
    return { info: job.info, output, dropped };
  }

  kill(id: string): JobInfo | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.info.status === 'running') {
      killTree(job.info.pid);
      job.info = { ...job.info, status: 'killed' };
    }
    return job.info;
  }

  list(): JobInfo[] {
    return [...this.jobs.values()].map((j) => j.info);
  }

  /** 同步杀掉所有运行中的任务（进程退出时调用） */
  killAll(): void {
    for (const job of this.jobs.values()) {
      if (job.info.status !== 'running') continue;
      killTree(job.info.pid, { sync: true });
      job.info = { ...job.info, status: 'killed' };
    }
  }

  dispose(): void {
    this.killAll();
    registries.delete(this);
  }
}

export const JOBS_KEY = 'bash-jobs';

/** 从 ToolServices 取（或创建）本会话的后台任务注册表 */
export function getJobRegistry(services: ToolServices): JobRegistry {
  const existing = services.get<JobRegistry>(JOBS_KEY);
  if (existing) return existing;
  const created = new JobRegistry();
  services.set(JOBS_KEY, created);
  return created;
}
