/**
 * 前台命令执行：保证在任何情况下都会 settle。
 * - signal 已中断：不启动进程
 * - 进程 exit 后若管道迟迟不 close（命令把子进程放到后台占住管道），宽限期后强制收尾
 * - abort / 超时：杀进程树；孙进程占住管道时，宽限期后销毁管道强制收尾
 * - 进程已正常退出后才到达的 abort 不改写结果（结果有效）
 */
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { OutputCollector, utf8ChildEnv, type StreamName } from './output.js';
import { killChildTree, resolveShell } from './shell.js';

/** 进程退出后等待管道关闭的宽限期 */
const EXIT_GRACE_MS = 500;
/** 杀进程树后等待管道关闭的宽限期 */
const KILL_GRACE_MS = 1500;

export type RunOutcome =
  | { kind: 'exited'; output: string; code: number | null; signal: NodeJS.Signals | null }
  | { kind: 'aborted'; output: string }
  | { kind: 'timeout'; output: string }
  | { kind: 'spawn-error'; message: string };

export interface RunOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  /** 调用方中断（ESC） */
  signal: AbortSignal;
  /** 实时输出（按流 UTF-8 流式解码，仅供展示；最终结果仍以 collector 的整体解码为准） */
  onOutput?: (text: string, stream: StreamName) => void;
  /** 额外环境变量 */
  env?: Record<string, string>;
  /** 写入 stdin 后关闭（钩子的 JSON 负载） */
  input?: string;
}

export function runForeground(opts: RunOptions): Promise<RunOutcome> {
  if (opts.signal.aborted) return Promise.resolve({ kind: 'aborted', output: '' });
  const shell = resolveShell();
  return new Promise<RunOutcome>((resolve) => {
    const collector = new OutputCollector();
    const child = spawn(shell.file, [...shell.prefix, opts.command], {
      cwd: opts.cwd,
      env: utf8ChildEnv(opts.env ? { ...process.env, ...opts.env } : process.env),
      // POSIX 下独立进程组以便整组 SIGKILL；Windows 用 taskkill /T
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    let settled = false;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let stopReason: 'aborted' | 'timeout' | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutTimer = setTimeout(() => stop('timeout'), opts.timeoutMs);

    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
      opts.signal.removeEventListener('abort', onAbort);
      child.stdout?.destroy();
      child.stderr?.destroy();
      const output = collector.text();
      if (stopReason) resolve({ kind: stopReason, output });
      else resolve({ kind: 'exited', output, code: exit?.code ?? null, signal: exit?.signal ?? null });
    };

    function stop(reason: 'aborted' | 'timeout'): void {
      if (settled) return;
      // 进程已正常退出：结果有效，只是管道还没关 —— 立即收尾而不是标记为中断
      if (exit) return settle();
      stopReason = reason;
      killChildTree(child);
      if (graceTimer) clearTimeout(graceTimer);
      graceTimer = setTimeout(settle, KILL_GRACE_MS);
    }
    function onAbort(): void {
      stop('aborted');
    }
    opts.signal.addEventListener('abort', onAbort, { once: true });

    const live = { out: new StringDecoder('utf8'), err: new StringDecoder('utf8') };
    const onData = (stream: StreamName) => (d: Buffer) => {
      collector.push(stream, d);
      if (!opts.onOutput) return;
      const text = live[stream].write(d);
      if (text) opts.onOutput(text, stream);
    };
    child.stdout?.on('data', onData('out'));
    child.stderr?.on('data', onData('err'));
    if (opts.input !== undefined) {
      child.stdin?.on('error', () => {});
      child.stdin?.end(opts.input);
    }
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      opts.signal.removeEventListener('abort', onAbort);
      resolve({ kind: 'spawn-error', message: err.message });
    });
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      if (!stopReason && !settled) graceTimer = setTimeout(settle, EXIT_GRACE_MS);
    });
    child.on('close', settle);
  });
}
